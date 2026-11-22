// Predict where someone could be, starting from a last-seen point.
//
//   node run.js
//       Asks for the latitude, longitude, minutes and walking speed.
//   node run.js <latitude> <longitude> [minutes] [personalSpeed]
//       Uses the location given; asks for anything left out.
//
// Each run saves, in this folder:
//   prediction_map.html           an interactive map: open it in a browser
//   predictions_<minutes>min.csv  every reachable cell, for ArcGIS Pro
//                                 (XY Table To Point, x = LON, y = LAT)
//   prediction_<minutes>min.png   a quick picture of the likeliest area
//
// Needs only Node.js. The map page loads its map tiles and two small
// libraries from the internet, so open it while online.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const T = require("./terrain.js");

const { GRID } = T;
const LAND = { 1: "Water", 2: "Trees", 7: "Built area", 11: "Rangeland", 12: "Shallow water" };
const MAP_TIMES = [15, 30, 60, 120];   // minutes shown as buttons on the map page
const WANDER_SCALE = 3;                // see predict() in terrain.js; a placeholder to tune
const REACH_MPS = 2;                   // "farthest anyone could walk", meters per second
const FLAT_TOBLER_MPS = T.toblerSpeed(0);
const CELL_HA = (GRID.cellM * GRID.cellM) / 10000;

// ---------- Questions (answers are queued, so none are lost) ----------

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
    if (closed) throw new Error("No answer given.");
    console.log("  Please type a number" + (min !== undefined ? ` from ${min} to ${max}` : "") + ".");
  }
}

// ---------- PNG writer (no libraries) ----------

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
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}
const BASE = { 1: [29, 78, 126], 12: [45, 98, 150], 2: [52, 58, 56], 7: [70, 70, 72], 11: [62, 62, 56] };
const HEAT = [[194, 65, 12], [234, 120, 50], [250, 180, 130], [253, 227, 207]];
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x)), f = x - i;
  return HEAT[i].map((v, k) => v + (HEAT[i + 1][k] - v) * f);
}
function drawPng(file, land, scores, trail, startId, scale = 3) {
  const { rows: R, cols: C } = GRID;
  let top = 0;
  for (const s of scores) if (s > top) top = s;
  const W = C * scale, H = R * scale, rgb = Buffer.alloc(W * H * 3);
  const sr = Math.floor(startId / C), sc = startId % C;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const id = r * C + c;
      let color = land[id] ? (BASE[land[id]] ?? [60, 60, 60]) : [24, 24, 26];
      if (trail[id] && land[id]) color = [95, 185, 138];
      const t = top > 0 ? scores[id] / top : 0;
      if (t > 0.03) {
        const h = heatColor(Math.sqrt(t)), a = 0.45 + 0.5 * t;
        color = color.map((v, k) => v * (1 - a) + h[k] * a);
      }
      const ring = Math.hypot(r - sr, c - sc);
      if (ring <= 2.2) color = ring <= 1.1 ? [10, 10, 10] : [255, 255, 255];
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

// ---------- Grid helpers ----------

function fitAffine(rows) {
  // Least squares: lon/lat = a*x + b*y + c, with x = col + 0.5, y = row + 0.5.
  const fit = (key) => {
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0, sxv = 0, syv = 0, sv = 0;
    for (const r of rows) {
      if (!Number.isFinite(r[key])) continue;
      const x = (r.Cell_ID % GRID.cols) + 0.5, y = Math.floor(r.Cell_ID / GRID.cols) + 0.5, v = r[key];
      sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; n++;
      sxv += x * v; syv += y * v; sv += v;
    }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [sxv, syv, sv];
    for (let i = 0; i < 3; i++) {             // Gaussian elimination
      for (let j = i + 1; j < 3; j++) {
        const f = A[j][i] / A[i][i];
        for (let k = i; k < 3; k++) A[j][k] -= f * A[i][k];
        b[j] -= f * b[i];
      }
    }
    const out = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < 3; k++) s -= A[i][k] * out[k];
      out[i] = s / A[i][i];
    }
    return out;
  };
  return { lon: fit("LON"), lat: fit("LAT") };
}

function neighborsOf(id) {
  const { rows: R, cols: C } = GRID, r = Math.floor(id / C), c = id % C, out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r2 = r + dr, c2 = c + dc;
      out.push(r2 < 0 || r2 >= R || c2 < 0 || c2 >= C ? -1 : r2 * C + c2);
    }
  }
  return out;
}

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");

// ---------- One prediction ----------

function predictFor(ctx, minutes) {
  const { edges, rows, startId, speed, land, trailNear, edgeCell } = ctx;
  const elapsedS = minutes * 60;
  const times = T.travelTimes(edges, startId, elapsedS, speed);
  const scores = T.predict({ edges, rows, startId, elapsedS, times, wanderScale: WANDER_SCALE });
  const reachTimes = T.travelTimes(edges, startId, elapsedS, REACH_MPS / FLAT_TOBLER_MPS);

  const { cols: C } = GRID, sr = Math.floor(startId / C), sc = startId % C;
  const cells = [];
  let onTrail = 0, atEdge = 0, built = 0, top = 0;
  for (let id = 0; id < scores.length; id++) {
    const p = scores[id];
    if (!(p > 0)) continue;
    const d = GRID.cellM * Math.hypot(Math.floor(id / C) - sr, (id % C) - sc);
    cells.push({ id, p, d });
    if (trailNear[id]) onTrail += p;
    if (edgeCell[id]) atEdge += p;
    if (land[id] === 7) built += p;
    if (p > top) top = p;
  }
  const byDist = [...cells].sort((a, b) => a.d - b.d);
  const quantile = (q) => { let acc = 0; for (const c of byDist) { acc += c.p; if (acc >= q) return c.d; } return byDist.at(-1)?.d ?? 0; };
  const byP = [...cells].sort((a, b) => b.p - a.p);
  let acc = 0, n50 = 0, n95 = 0, s50 = 0, s95 = 0;
  for (let i = 0; i < byP.length; i++) {
    acc += byP[i].p;
    if (!n50 && acc >= 0.5) { n50 = i + 1; s50 = byP[i].p; }
    if (!n95 && acc >= 0.95) { n95 = i + 1; s95 = byP[i].p; break; }
  }

  const rel = new Uint16Array(scores.length), reach = new Uint8Array(scores.length);
  for (let id = 0; id < scores.length; id++) {
    rel[id] = top > 0 ? Math.round((scores[id] / top) * 65535) : 0;
    reach[id] = Number.isFinite(reachTimes[id]) && land[id] ? 1 : 0;
  }
  return {
    minutes, scores, ranked: byP,
    page: {
      minutes, label: minutes < 60 || minutes % 60 ? `${minutes} min` : `${minutes / 60} h`,
      rel: b64(rel), reach: b64(reach), s50: top ? s50 / top : 0, s95: top ? s95 / top : 0,
      stats: {
        median: quantile(0.5), p95: quantile(0.95), ha50: n50 * CELL_HA, ha95: n95 * CELL_HA,
        onTrail, built, atEdge, reachKm: (REACH_MPS * elapsedS) / 1000, cells: cells.length,
      },
    },
  };
}

// ---------- Outputs ----------

function writeCsvAndPng(ctx, result) {
  const label = String(result.minutes).replace(".", "_");
  const csv = path.join(__dirname, `predictions_${label}min.csv`);
  const png = path.join(__dirname, `prediction_${label}min.png`);
  fs.writeFileSync(csv, ["Cell_ID,LON,LAT,score"].concat(result.ranked.map(({ id, p }) => {
    const r = ctx.byId.get(id);
    return `${id},${r.LON},${r.LAT},${p}`;
  })).join("\n"));
  drawPng(png, ctx.land, result.scores, ctx.trail, ctx.startId);
  return [csv, png];
}

function writeMap(ctx, results, selected) {
  const data = {
    cols: GRID.cols, rows: GRID.rows, cellM: GRID.cellM, aff: ctx.aff,
    land: b64(ctx.land), trail: b64(ctx.trail), start: ctx.startId,
    startLatLon: [ctx.lat, ctx.lon], speed: ctx.speed, wanderScale: WANDER_SCALE, reachMps: REACH_MPS,
    selected, times: results.map((r) => r.page), made: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
  const html = MAP_TEMPLATE.replace("__DATA__", JSON.stringify(data).replace(/</g, "\\u003c"));
  const file = path.join(__dirname, "prediction_map.html");
  fs.writeFileSync(file, html);
  return file;
}

function printTop(ctx, result) {
  const s = result.page.stats;
  console.log(`\nAfter ${result.page.label}: half the chance is within ${Math.round(s.median)} m, ` +
    `95% within ${Math.round(s.p95)} m (${s.cells} cells reachable)\n`);
  console.log("Rank  Latitude   Longitude    Chance  Terrain");
  result.ranked.slice(0, 5).forEach(({ id, p }, i) => {
    const r = ctx.byId.get(id);
    console.log(`${String(i + 1).padStart(4)}  ${r.LAT.toFixed(5)}  ${r.LON.toFixed(5)}  ` +
      `${(p * 100).toFixed(3).padStart(7)}%  ${LAND[r.MAJORITY] ?? "Unknown"}`);
  });
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2).map(Number);
  console.log("Loading weights...");
  const rows = T.readCsv(fs.readFileSync(path.join(__dirname, "weights.csv"), "utf8"));
  const byId = new Map(rows.map((r) => [r.Cell_ID, r]));
  const edges = T.edgesFromWeights(rows);

  const n = GRID.rows * GRID.cols;
  const land = new Uint8Array(n), trail = new Uint8Array(n);
  for (const r of rows) {
    land[r.Cell_ID] = Number.isFinite(r.MAJORITY) ? r.MAJORITY : 255;
    trail[r.Cell_ID] = r.MAX >= 1 ? 1 : 0;
  }
  const trailNear = new Uint8Array(n), edgeCell = new Uint8Array(n);
  for (let id = 0; id < n; id++) {
    if (!land[id]) continue;
    const nb = neighborsOf(id);
    if (trail[id] || nb.some((j) => j >= 0 && trail[j])) trailNear[id] = 1;
    if (nb.some((j) => j < 0 || !land[j])) edgeCell[id] = 1;
  }

  const lat = Number.isFinite(args[0]) ? args[0] : await askNumber("Last-seen latitude (e.g. 37.2690): ", { min: -90, max: 90 });
  const lon = Number.isFinite(args[1]) ? args[1] : await askNumber("Last-seen longitude (e.g. -76.7330): ", { min: -180, max: 180 });
  const startId = T.nearestCell(rows, lon, lat);
  const start = byId.get(startId);
  const away = Math.hypot((start.LON - lon) * 111320 * Math.cos((lat * Math.PI) / 180), (start.LAT - lat) * 110950);
  if (away > 50) console.log(`Warning: that point is ${Math.round(away)} m from the nearest grid cell, so it may be outside the area.`);
  if (!(start.speed_mult > 0)) console.log("Warning: the starting cell is blocked (water or no data), so nothing may be reachable.");

  let minutes = Number.isFinite(args[2]) ? args[2] : await askNumber("Minutes since last seen: ", { min: 0.5, max: 600 });
  const speed = Number.isFinite(args[3]) ? args[3] : await askNumber("Walking speed (Enter for 1.0; 1.2 = 20% faster): ", { fallback: 1, min: 0.1, max: 5 });

  const ctx = { rows, byId, edges, land, trail, trailNear, edgeCell, startId, speed, lat, lon, aff: fitAffine(rows) };
  const cache = new Map();
  const get = (m) => { if (!cache.has(m)) cache.set(m, predictFor(ctx, m)); return cache.get(m); };
  console.log("Working out the map times (15 min, 30 min, 1 h, 2 h)...");
  MAP_TIMES.forEach(get);

  for (;;) {
    const result = get(minutes);
    printTop(ctx, result);
    const [csv, png] = writeCsvAndPng(ctx, result);
    const all = [...cache.values()].sort((a, b) => a.minutes - b.minutes);
    const map = writeMap(ctx, all, minutes);
    console.log(`\nSaved ${path.basename(map)} (open it in a browser), ${path.basename(csv)} and ${path.basename(png)}`);

    let next = null;
    while (next === null) {
      const again = (await ask("\nTry another time? Type minutes, or press Enter to finish: ")).trim();
      if (again === "") break;
      const v = Number(again);
      if (Number.isFinite(v) && v >= 0.5 && v <= 600) next = v;
      else console.log("  Please type a number from 0.5 to 600.");
    }
    if (next === null) break;
    minutes = next;
  }
  rl.close();
}

// ---------- Map page ----------

const MAP_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search Area Map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  :root {
    --bg: #141517; --panel: #1c1d20; --line: #2c2e33; --ink: #e8e6e3; --muted: #9a9894;
    --accent: #f0a272; --heat-lo: #c2410c; --heat-hi: #fde3cf; --trail: #5fb98a; --water: #1d4e7e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink);
    font: 13px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 10px 16px;
    border-bottom: 1px solid var(--line); background: var(--panel); }
  .bar .lbl { color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .times { display: flex; gap: 4px; }
  .times button { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line);
    border-radius: 4px; padding: 5px 12px; cursor: pointer; }
  .times button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .toggles { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .toggles label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .toggles input { accent-color: #4d8ef7; margin: 0; }
  .main { display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
  #map { background: #0e0f10; min-height: 360px; }
  aside { border-left: 1px solid var(--line); overflow: auto; background: var(--bg); }
  .card { border-bottom: 1px solid var(--line); padding: 14px 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
  .stat { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0;
    border-top: 1px solid var(--line); color: var(--muted); }
  .stat b { color: var(--ink); font-weight: 600; white-space: nowrap; }
  .ramp { height: 8px; border-radius: 2px; margin: 4px 0;
    background: linear-gradient(90deg, rgba(194,65,12,.35), #ea7832 45%, #fde3cf); }
  .rampl { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
  .key { display: flex; align-items: center; gap: 10px; margin-top: 8px; color: var(--muted); }
  .sw { width: 26px; flex: none; }
  .note { color: var(--muted); font-size: 11.5px; margin: 0; }
  .lastseen { background: transparent; border: 0; box-shadow: none; color: var(--ink);
    font: 600 12px ui-monospace, Menlo, Consolas, monospace; text-shadow: 0 0 3px #000, 0 0 3px #000; }
  .lastseen::before { display: none; }
  .north { color: var(--ink); font: 600 12px ui-monospace, Menlo, monospace; text-align: center;
    text-shadow: 0 0 3px #000; line-height: 1; }
  .leaflet-control-scale-line { background: rgba(20,21,23,.8); color: var(--ink); border-color: var(--ink); }
  .leaflet-container { font: inherit; }
  .leaflet-control-attribution { background: rgba(20,21,23,.75) !important; color: var(--muted); }
  .leaflet-control-attribution a { color: #b8b5b0; }
  .offline { padding: 40px; color: var(--muted); }
  @media (max-width: 760px) {
    .main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; }
    aside { border-left: 0; border-top: 1px solid var(--line); }
  }
</style>
</head>
<body>
<div class="app">
  <div class="bar">
    <span class="lbl">Time since last seen</span>
    <div class="times" id="times"></div>
    <span class="lbl">Show</span>
    <div class="toggles">
      <label><input type="checkbox" data-layer="heat" checked> Heat</label>
      <label><input type="checkbox" data-layer="a50" checked> 50% area</label>
      <label><input type="checkbox" data-layer="a95" checked> 95% area</label>
      <label><input type="checkbox" data-layer="reach" checked> Reach limit</label>
      <label><input type="checkbox" data-layer="trails" checked> Trails</label>
    </div>
  </div>
  <div class="main">
    <div id="map"></div>
    <aside>
      <div class="card">
        <h2 id="title">After 15 minutes</h2>
        <div id="stats"></div>
      </div>
      <div class="card">
        <h2>Key</h2>
        <div class="ramp"></div>
        <div class="rampl"><span>less likely</span><span>more</span></div>
        <div class="key"><svg class="sw" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="#fde3cf" stroke-width="2.2"/></svg>Smallest area holding 50% of the chance</div>
        <div class="key"><svg class="sw" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="#ea7832" stroke-width="1.8"/></svg>Smallest area holding 95%</div>
        <div class="key"><svg class="sw" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="#d9d6d0" stroke-width="1.4" stroke-dasharray="5 4"/></svg><span id="reachKey">Reach limit: farthest anyone could walk</span></div>
        <div class="key"><svg class="sw" height="14"><circle cx="13" cy="7" r="5" fill="#111" stroke="#fff" stroke-width="2.5"/></svg>Point last seen</div>
        <div class="key"><svg class="sw" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="#5fb98a" stroke-width="2" stroke-dasharray="2 3"/></svg>Trail</div>
        <div class="key"><svg class="sw" height="12"><rect x="0" y="1" width="26" height="10" rx="2" fill="#1d4e7e"/></svg>Water (blocked)</div>
        <div class="key"><svg class="sw" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="#fff" stroke-opacity=".6" stroke-width="1.2"/></svg>Edge of the mapped area</div>
      </div>
      <div class="card">
        <p class="note" id="model"></p>
      </div>
    </aside>
  </div>
</div>
<script id="data" type="application/json">__DATA__</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>
(function () {
  if (!window.L || !window.d3) {
    document.getElementById("map").innerHTML = '<div class="offline">The map needs an internet connection to load. Connect and reload this page.</div>';
    return;
  }
  var D = JSON.parse(document.getElementById("data").textContent);
  var C = D.cols, R = D.rows, N = C * R;
  function bytes(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function u16(s) { var u = bytes(s); return new Uint16Array(u.buffer, 0, u.length / 2); }
  var land = bytes(D.land), trail = bytes(D.trail);

  function toLatLng(p) {
    var x = p[0], y = p[1];
    return [D.aff.lat[0] * x + D.aff.lat[1] * y + D.aff.lat[2], D.aff.lon[0] * x + D.aff.lon[1] * y + D.aff.lon[2]];
  }
  function contour(values, t) {
    var g = d3.contours().size([C, R]).thresholds([t])(values)[0];
    return g.coordinates.map(function (poly) { return poly.map(function (ring) { return ring.map(toLatLng); }); });
  }
  function maskValues(test) { var v = new Float64Array(N); for (var i = 0; i < N; i++) v[i] = test(i) ? 1 : 0; return v; }

  var map = L.map("map", { zoomControl: true, attributionControl: true, preferCanvas: false });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
  ["water", "trails", "heat", "lines", "pin"].forEach(function (name, i) { map.createPane(name).style.zIndex = 410 + i * 10; });

  var dataMask = maskValues(function (i) { return land[i] > 0; });
  var footprint = L.polygon(contour(dataMask, 0.5), { pane: "water", color: "#fff", weight: 1.2, opacity: 0.6, fill: false, interactive: false }).addTo(map);
  L.polygon(contour(maskValues(function (i) { return land[i] === 1 || land[i] === 12; }), 0.5),
    { pane: "water", stroke: false, fillColor: "#1d4e7e", fillOpacity: 0.85, interactive: false }).addTo(map);

  var trailRenderer = L.canvas({ pane: "trails" });
  var trails = L.layerGroup();
  for (var i = 0; i < N; i++) {
    if (!trail[i] || !land[i]) continue;
    var c = i % C, r = Math.floor(i / C);
    L.circleMarker(toLatLng([c + 0.5, r + 0.5]), { renderer: trailRenderer, radius: 1.4, stroke: false,
      fillColor: "#5fb98a", fillOpacity: 0.9, interactive: false }).addTo(trails);
  }
  trails.addTo(map);

  var sc = D.start % C, sr = Math.floor(D.start / C), startLL = toLatLng([sc + 0.5, sr + 0.5]);
  L.circleMarker(startLL, { pane: "pin", radius: 7, color: "#fff", weight: 3, fillColor: "#111", fillOpacity: 1 })
    .bindTooltip("Last seen", { permanent: true, direction: "right", offset: [10, 0], className: "lastseen" }).addTo(map);

  var North = L.Control.extend({ options: { position: "topright" },
    onAdd: function () { var d = L.DomUtil.create("div", "north"); d.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1 L13 15 L8 11 L3 15 Z" fill="#e8e6e3"/></svg><br>N'; return d; } });
  new North().addTo(map);
  L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);
  map.fitBounds(footprint.getBounds(), { padding: [12, 12] });

  var HEAT_STEPS = [0.03, 0.07, 0.13, 0.22, 0.34, 0.5, 0.68, 0.85];
  function heatColor(k) {
    var t = k / (HEAT_STEPS.length - 1);
    return d3.interpolateRgbBasis(["#c2410c", "#ea7832", "#f7b48a", "#fde3cf"])(t);
  }
  function blur(v) {
    var out = new Float64Array(N);
    for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
      var s = 0, n = 0;
      for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
        var r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= R || c2 < 0 || c2 >= C) continue;
        s += v[r2 * C + c2]; n++;
      }
      out[r * C + c] = s / n;
    }
    return out;
  }

  var layers = {}, current = null;
  function build(t) {
    var raw = u16(t.rel), rel = new Float64Array(N);
    for (var i = 0; i < N; i++) rel[i] = raw[i] / 65535;
    var smooth = blur(rel), heat = L.layerGroup();
    HEAT_STEPS.forEach(function (th, k) {
      L.polygon(contour(smooth, th), { pane: "heat", stroke: false, fillColor: heatColor(k),
        fillOpacity: 0.2 + 0.08 * k, interactive: false }).addTo(heat);
    });
    var reach = bytes(t.reach), reachVals = new Float64Array(N);
    for (var j = 0; j < N; j++) reachVals[j] = reach[j];
    return {
      heat: heat,
      a95: L.polygon(contour(rel, t.s95), { pane: "lines", color: "#ea7832", weight: 1.8, fill: false, interactive: false }),
      a50: L.polygon(contour(rel, t.s50), { pane: "lines", color: "#fde3cf", weight: 2.2, fill: false, interactive: false }),
      reach: L.polygon(contour(reachVals, 0.5), { pane: "lines", color: "#d9d6d0", weight: 1.4, dashArray: "6 5", fill: false, interactive: false })
    };
  }

  function fmtM(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }
  function pct(x) { return Math.round(x * 100) + "%"; }
  function show(idx) {
    var t = D.times[idx];
    if (!layers[idx]) layers[idx] = build(t);
    if (current !== null) Object.keys(layers[current]).forEach(function (k) { map.removeLayer(layers[current][k]); });
    current = idx;
    document.querySelectorAll("[data-layer]").forEach(function (box) {
      var k = box.getAttribute("data-layer");
      if (k !== "trails" && box.checked) layers[idx][k].addTo(map);
    });
    document.querySelectorAll("#times button").forEach(function (b, i) { b.setAttribute("aria-pressed", i === idx ? "true" : "false"); });
    var s = t.stats;
    document.getElementById("title").textContent = "After " + t.label.replace(" min", " minutes").replace(/ h$/, t.minutes === 60 ? " hour" : " hours");
    var rowsHtml = [
      ["Median distance from last seen", fmtM(s.median)],
      ["95th percentile distance", fmtM(s.p95)],
      ["50% area", s.ha50.toFixed(1) + " ha"],
      ["95% area", s.ha95.toFixed(1) + " ha"],
      ["On or next to a trail", pct(s.onTrail)],
      ["In built-up area", pct(s.built)],
      ["At the edge of the mapped area", pct(s.atEdge)],
      ["Reach limit", s.reachKm.toFixed(2) + " km by path"]
    ].map(function (r) { return '<div class="stat"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>"; }).join("");
    document.getElementById("stats").innerHTML = rowsHtml;
  }

  var bar = document.getElementById("times");
  D.times.forEach(function (t, i) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = t.label;
    b.addEventListener("click", function () { show(i); });
    bar.appendChild(b);
  });
  document.querySelectorAll("[data-layer]").forEach(function (box) {
    box.addEventListener("change", function () {
      var k = box.getAttribute("data-layer");
      var layer = k === "trails" ? trails : layers[current][k];
      if (box.checked) layer.addTo(map); else map.removeLayer(layer);
    });
  });
  document.getElementById("reachKey").textContent = "Reach limit: farthest anyone could walk (" + D.reachMps + " m/s, around water)";
  document.getElementById("model").textContent = "Last seen at " + D.startLatLon[0].toFixed(5) + ", " + D.startLatLon[1].toFixed(5) +
    ". Walking speed x" + D.speed + ". Wandering model, scale " + D.wanderScale +
    ": a starting assumption, not yet tuned to real tracks. Made " + D.made + ".";
  var sel = D.times.findIndex(function (t) { return t.minutes === D.selected; });
  show(sel < 0 ? 0 : sel);
  // Open zoomed to the likely area (with room around it), not the whole grid.
  map.fitBounds(layers[current].a95.getBounds().extend(startLL).pad(0.35));
})();
</script>
</body>
</html>
`;

main().catch((err) => { console.error(err.message); rl.close(); process.exit(1); });
