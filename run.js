// Predict where someone could be, starting from a last-seen point.
//
//   node run.js
//       Asks for the latitude, longitude, minutes and walking speed.
//   node run.js <latitude> <longitude> [minutes] [personalSpeed]
//       Uses the location given; asks for anything left out.
//
// Each run saves two files in this folder:
//   predictions_<minutes>min.csv  every reachable cell, for ArcGIS Pro
//                                 (XY Table To Point, x = LON, y = LAT)
//   prediction_<minutes>min.png   a map of the likeliest area

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const Papa = require("papaparse");
const { GRID, edgesFromWeights, predict, nearestCell } = require("./terrain.js");

const LAND = { 1: "Water", 2: "Trees", 7: "Built area", 11: "Rangeland", 12: "Shallow water" };

// ---------- Questions ----------

// Answers are queued, so none are lost if they're typed or pasted early.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [], waiting = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => { closed = true; while (waiting.length) waiting.shift()(""); });
const ask = (q) => {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => waiting.push(resolve));
};

async function askNumber(question, { fallback, min, max } = {}) {
  for (;;) {
    const raw = (await ask(question)).trim();
    if (raw === "" && fallback !== undefined) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) return n;
    console.log("  Please type a number" + (min !== undefined ? ` from ${min} to ${max}` : "") + ".");
  }
}

// ---------- Map image (a small PNG writer, no libraries needed) ----------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // no filter
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

// Base colors for the terrain, then a yellow-to-red heat layer on top.
const BASE = {
  1: [156, 195, 230], 12: [190, 215, 238], 2: [205, 225, 198],
  7: [222, 218, 212], 11: [236, 230, 200],
};
const OUTSIDE = [255, 255, 255];
const HEAT = [[255, 237, 160], [254, 178, 76], [240, 59, 32], [140, 10, 40]];

function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x)), f = x - i;
  return HEAT[i].map((v, k) => v + (HEAT[i + 1][k] - v) * f);
}

function drawMap(file, rows, scores, startId, scale = 3) {
  const { rows: R, cols: C } = GRID;
  const land = new Map(rows.map((r) => [r.Cell_ID, r.MAJORITY]));
  let top = 0;
  for (const s of scores) if (s > top) top = s;
  const W = C * scale, H = R * scale, rgb = Buffer.alloc(W * H * 3);
  const sr = Math.floor(startId / C), sc = startId % C;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const id = r * C + c;
      let color = land.has(id) ? BASE[land.get(id)] ?? [230, 230, 230] : OUTSIDE;
      const t = top > 0 ? scores[id] / top : 0;
      if (t > 0.02) {
        const h = heatColor(t), a = 0.35 + 0.65 * t;
        color = color.map((v, k) => v * (1 - a) + h[k] * a);
      }
      if (Math.abs(r - sr) <= 1 && Math.abs(c - sc) <= 1) color = [20, 20, 20]; // start
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const p = ((r * scale + y) * W + c * scale + x) * 3;
          rgb[p] = color[0]; rgb[p + 1] = color[1]; rgb[p + 2] = color[2];
        }
      }
    }
  }
  writePng(file, W, H, rgb);
}

// ---------- Prediction ----------

function runPrediction(rows, byId, edges, startId, minutes, speed) {
  const scores = predict({ edges, rows, startId, elapsedS: minutes * 60, personalSpeed: speed });
  const ranked = [];
  for (let id = 0; id < scores.length; id++) {
    if (scores[id] > 0 && byId.has(id)) ranked.push({ id, score: scores[id] });
  }
  ranked.sort((a, b) => b.score - a.score);

  console.log(`\n${minutes} minutes from cell ${startId}: ${ranked.length} cells reachable\n`);
  console.log("Rank  Latitude   Longitude    Chance  Terrain");
  ranked.slice(0, 10).forEach(({ id, score }, i) => {
    const r = byId.get(id);
    console.log(`${String(i + 1).padStart(4)}  ${r.LAT.toFixed(5)}  ${r.LON.toFixed(5)}  ` +
      `${(score * 100).toFixed(4).padStart(7)}%  ${LAND[r.MAJORITY] ?? "Unknown"}`);
  });

  const label = String(minutes).replace(".", "_");
  const csv = path.join(__dirname, `predictions_${label}min.csv`);
  const png = path.join(__dirname, `prediction_${label}min.png`);
  fs.writeFileSync(csv, ["Cell_ID,LON,LAT,score"].concat(ranked.map(({ id, score }) => {
    const r = byId.get(id);
    return `${id},${r.LON},${r.LAT},${score}`;
  })).join("\n"));
  drawMap(png, rows, scores, startId);
  console.log(`\nSaved ${path.basename(csv)} and ${path.basename(png)}`);
}

async function main() {
  const args = process.argv.slice(2).map(Number);

  console.log("Loading weights...");
  const rows = Papa.parse(fs.readFileSync(path.join(__dirname, "weights.csv"), "utf8"),
    { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
  const byId = new Map(rows.map((r) => [r.Cell_ID, r]));
  const edges = edgesFromWeights(rows);

  const lat = Number.isFinite(args[0]) ? args[0] : await askNumber("Last-seen latitude (e.g. 37.2690): ", { min: -90, max: 90 });
  const lon = Number.isFinite(args[1]) ? args[1] : await askNumber("Last-seen longitude (e.g. -76.7330): ", { min: -180, max: 180 });

  const startId = nearestCell(rows, lon, lat);
  const start = byId.get(startId);
  const away = Math.hypot((start.LON - lon) * 111320 * Math.cos((lat * Math.PI) / 180), (start.LAT - lat) * 110950);
  if (away > 50) console.log(`Warning: that point is ${Math.round(away)} m from the nearest grid cell, so it may be outside the area.`);
  if (!(start.speed_mult > 0)) console.log("Warning: the starting cell is blocked (water or no data), so nothing may be reachable.");

  let minutes = Number.isFinite(args[2]) ? args[2] : await askNumber("Minutes since last seen: ", { min: 0.5, max: 600 });
  const speed = Number.isFinite(args[3]) ? args[3] : await askNumber("Walking speed (Enter for 1.0; 1.2 = 20% faster): ", { fallback: 1, min: 0.1, max: 5 });

  for (;;) {
    runPrediction(rows, byId, edges, startId, minutes, speed);
    let next = null;
    while (next === null) {
      const again = (await ask("\nTry another time? Type minutes, or press Enter to finish: ")).trim();
      if (again === "") break;
      const n = Number(again);
      if (Number.isFinite(n) && n >= 0.5 && n <= 600) next = n;
      else console.log("  Please type a number from 0.5 to 600.");
    }
    if (next === null) break;
    minutes = next;
  }
  rl.close();
}

main().catch((err) => { console.error(err.message); rl.close(); process.exit(1); });
