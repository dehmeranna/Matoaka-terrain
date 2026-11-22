// Terrain travel model for the Lake Matoaka grid.
// Loads the eight direction times from weights.csv (made in ArcGIS Pro),
// or builds them from elevation and speed with Tobler's hiking function,
// then predicts where someone could be after a given time.

// 207 columns x 223 rows of 11 m cells; Cell_ID = row x 207 + col,
// with row 0 at the north edge.
const GRID = { rows: 223, cols: 207, cellM: 11 };

// Column names differ between exports, so accept either spelling.
const field = (r, ...names) => {
  for (const k of names) if (r[k] !== undefined) return r[k];
  return undefined;
};
const cellId = (r) => Number(field(r, "Cell_ID", "CELL_ID", "cell_id"));
const isBlank = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v));

// Esri 10 m land cover codes, plus 12 for the shallow-water edge.
const LAND_NAMES = {
  1: "Water", 2: "Trees", 4: "Flooded vegetation", 5: "Crops",
  7: "Built area", 8: "Bare ground", 11: "Rangeland", 12: "Shallow water",
};

const MAX_SLOPE_DEG = 70; // Esri's default cut angle for hiking time

// Tobler's hiking function: walking speed in meters per second for a
// slope given as rise over run in the direction of travel.
function toblerSpeed(slope) {
  return (6 * Math.exp(-3.5 * Math.abs(slope + 0.05))) / 3.6;
}

// Turn rows from cells.csv into fast lookup arrays indexed by CELL_ID.
// Empty values in the CSV (nulls) become NaN or 0, which blocks the cell.
function indexCells(rows, grid = GRID) {
  const n = grid.rows * grid.cols;
  const elev = new Float64Array(n).fill(NaN);
  const mult = new Float64Array(n);
  for (const r of rows) {
    const id = cellId(r);
    if (!Number.isInteger(id) || id < 0 || id >= n) continue;
    const z = field(r, "ELEV_M", "MEAN", "elev_m");
    const m = field(r, "SPEED_MULT", "speed_mult");
    elev[id] = isBlank(z) ? NaN : Number(z);
    mult[id] = isBlank(m) ? 0 : Number(m);
  }
  return { elev, mult };
}

// Build every directed move between 8-connected neighbors.
// Returns { from, to, time, slope, dist } as typed arrays.
function buildEdges(rows, grid = GRID) {
  const { rows: R, cols: C, cellM } = grid;
  const { elev, mult } = indexCells(rows, grid);
  const ok = (r, c) => {
    const id = r * C + c;
    return Number.isFinite(elev[id]) && mult[id] > 0;
  };
  const maxSlope = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);
  const dirs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  const from = [], to = [], time = [], slope = [], dist = [];
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (!ok(r, c)) continue;
      const a = r * C + c;
      for (const [dr, dc] of dirs) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C || !ok(r2, c2)) continue;
        const diagonal = dr !== 0 && dc !== 0;
        // No squeezing diagonally between two blocked corners.
        if (diagonal && !ok(r, c2) && !ok(r2, c)) continue;
        const b = r2 * C + c2;
        const d = diagonal ? cellM * Math.SQRT2 : cellM;
        const s = (elev[b] - elev[a]) / d;
        if (Math.abs(s) > maxSlope) continue;
        const v = toblerSpeed(s);
        // Half the move is spent in each cell, at that cell's terrain speed.
        const t = d / 2 / (v * mult[a]) + d / 2 / (v * mult[b]);
        from.push(a); to.push(b); time.push(t); slope.push(s); dist.push(d);
      }
    }
  }
  return {
    from: Int32Array.from(from), to: Int32Array.from(to),
    time: Float64Array.from(time), slope: Float64Array.from(slope),
    dist: Float64Array.from(dist), cellCount: R * C,
  };
}

// Load the moves straight from weights.csv: one row per cell, with the
// seconds to step to each neighbor in time_n ... time_nw. Blank = blocked.
const WEIGHT_DIRS = [
  ["time_n", -1, 0], ["time_ne", -1, 1], ["time_e", 0, 1], ["time_se", 1, 1],
  ["time_s", 1, 0], ["time_sw", 1, -1], ["time_w", 0, -1], ["time_nw", -1, -1],
];

function edgesFromWeights(rows, grid = GRID) {
  const { rows: R, cols: C, cellM } = grid;
  const from = [], to = [], time = [], dist = [];
  for (const r of rows) {
    const a = cellId(r);
    if (!Number.isInteger(a) || a < 0 || a >= R * C) continue;
    const row = Math.floor(a / C), col = a % C;
    for (const [name, dr, dc] of WEIGHT_DIRS) {
      const t = field(r, name, name.toUpperCase());
      if (isBlank(t) || Number(t) <= 0) continue;
      const r2 = row + dr, c2 = col + dc;
      if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C) continue;
      from.push(a); to.push(r2 * C + c2); time.push(Number(t));
      dist.push(dr !== 0 && dc !== 0 ? cellM * Math.SQRT2 : cellM);
    }
  }
  return {
    from: Int32Array.from(from), to: Int32Array.from(to),
    time: Float64Array.from(time), dist: Float64Array.from(dist), cellCount: R * C,
  };
}

// Shortest travel time in seconds from one cell to every other cell,
// stopping at maxSeconds. Unreached cells stay Infinity.
function travelTimes(edges, startId, maxSeconds, personalSpeed = 1) {
  const n = edges.cellCount, m = edges.from.length;
  const first = new Int32Array(n + 1);
  for (let k = 0; k < m; k++) first[edges.from[k] + 1]++;
  for (let i = 0; i < n; i++) first[i + 1] += first[i];
  const next = first.slice(), to = new Int32Array(m), cost = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const j = next[edges.from[k]]++;
    to[j] = edges.to[k];
    cost[j] = edges.time[k] / personalSpeed;
  }

  const times = new Float64Array(n).fill(Infinity);
  const heap = [[0, startId]];
  times[startId] = 0;
  const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
  while (heap.length) {
    const [t, id] = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        swap(i, s);
        i = s;
      }
    }
    if (t > times[id]) continue;
    for (let k = first[id]; k < first[id + 1]; k++) {
      const nt = t + cost[k];
      if (nt < times[to[k]] && nt <= maxSeconds) {
        times[to[k]] = nt;
        heap.push([nt, to[k]]);
        for (let i = heap.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          swap(i, p);
          i = p;
        }
      }
    }
  }
  return times;
}

// Score every cell by how likely the person is to be there after
// elapsedS seconds. Scores add up to 1.
function predict({ edges, rows, startId, elapsedS, personalSpeed = 1,
                   landPreference = {}, movingShare = 0.7, spread = 0.25 }) {
  const times = travelTimes(edges, startId, elapsedS, personalSpeed);
  const land = new Array(edges.cellCount);
  for (const r of rows) land[cellId(r)] = LAND_NAMES[r.MAJORITY];
  const scores = new Float64Array(edges.cellCount);
  let total = 0;
  for (let id = 0; id < edges.cellCount; id++) {
    const t = times[id];
    if (!Number.isFinite(t)) continue;
    const z = (t / elapsedS - movingShare) / spread;
    const score = Math.exp(-z * z) * (landPreference[land[id]] ?? 1);
    scores[id] = score;
    total += score;
  }
  return total > 0 ? scores.map((s) => s / total) : scores;
}

// Cell id for a GPS point: the cell whose center is closest.
function nearestCell(rows, lon, lat) {
  let best = -1, bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const r of rows) {
    if (isBlank(r.LON) || isBlank(r.LAT)) continue;
    const dx = (r.LON - lon) * k, dy = r.LAT - lat, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = cellId(r); }
  }
  return best;
}

module.exports = {
  GRID, LAND_NAMES, toblerSpeed, buildEdges, edgesFromWeights,
  travelTimes, predict, nearestCell,
};
