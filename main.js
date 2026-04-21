// glide-range: terrain + wind-aware paraglider reach estimator

// --- map setup --------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      otm: {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
          'SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      },
    },
    layers: [{ id: 'otm', type: 'raster', source: 'otm' }],
  },
  center: [-122.0306, 47.5133], // Poo Poo Point LZ, Tiger Mountain
  zoom: 13,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let pinMarker = null;
let pinLngLat = null;

map.on('click', (e) => {
  setPin(e.lngLat);
});

function setPin(lngLat) {
  if (pinMarker) pinMarker.remove();
  pinMarker = new maplibregl.Marker({ color: '#d9534f', draggable: true })
    .setLngLat(lngLat)
    .addTo(map);
  pinMarker.on('dragend', () => {
    pinLngLat = pinMarker.getLngLat();
    refreshPinReadout();
    scheduleCompute(0);
  });
  pinLngLat = pinMarker.getLngLat();
  refreshPinReadout();
  scheduleCompute(0);
}

function refreshPinReadout() {
  if (!pinLngLat) return;
  document.getElementById('coords').textContent =
    `${pinLngLat.lat.toFixed(5)}, ${pinLngLat.lng.toFixed(5)}`;
}

map.on('load', () => {
  map.addSource('glide', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'glide-fill',
    type: 'fill',
    source: 'glide',
    paint: { 'fill-color': '#00bcd4', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'glide-line',
    type: 'line',
    source: 'glide',
    paint: { 'line-color': '#006d77', 'line-width': 2 },
  });
  // Comparison overlay: fixed-100 m outline only, dashed, high-contrast.
  map.addSource('glide-compare', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'glide-compare-line',
    type: 'line',
    source: 'glide-compare',
    paint: {
      'line-color': '#d84315',
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });
  applyUrlState();
});

// Persist map pan/zoom in the URL too, after any user-initiated move.
map.on('moveend', (e) => {
  if (e.originalEvent) scheduleUrlWrite();
});

// --- terrain: Nextzen terrarium tiles --------------------------------------

const TILE_ZOOM = 12;
const TILE_SIZE = 256;
const TERRAIN_URL = (x, y, z) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const tileData = new Map(); // key -> ImageData
const tilePromises = new Map(); // key -> Promise<ImageData>

function lng2tileX(lng, z) {
  return ((lng + 180) / 360) * Math.pow(2, z);
}
function lat2tileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

function fetchTile(x, y, z) {
  const key = `${z}/${x}/${y}`;
  if (tileData.has(key)) return Promise.resolve(tileData.get(key));
  if (tilePromises.has(key)) return tilePromises.get(key);

  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      tileData.set(key, data);
      resolve(data);
    };
    img.onerror = () => reject(new Error(`tile ${key} failed`));
    img.src = TERRAIN_URL(x, y, z);
  });
  tilePromises.set(key, p);
  return p;
}

async function preloadTilesForBounds(bounds) {
  const { minLng, maxLng, minLat, maxLat } = bounds;
  const xMin = Math.floor(lng2tileX(minLng, TILE_ZOOM));
  const xMax = Math.floor(lng2tileX(maxLng, TILE_ZOOM));
  const yMin = Math.floor(lat2tileY(maxLat, TILE_ZOOM));
  const yMax = Math.floor(lat2tileY(minLat, TILE_ZOOM));
  const tasks = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      tasks.push(fetchTile(x, y, TILE_ZOOM).catch(() => null));
    }
  }
  await Promise.all(tasks);
}

function elevationAt(lat, lng) {
  const tx = lng2tileX(lng, TILE_ZOOM);
  const ty = lat2tileY(lat, TILE_ZOOM);
  const tileX = Math.floor(tx);
  const tileY = Math.floor(ty);
  const key = `${TILE_ZOOM}/${tileX}/${tileY}`;
  const data = tileData.get(key);
  if (!data) return null;
  let px = Math.floor((tx - tileX) * TILE_SIZE);
  let py = Math.floor((ty - tileY) * TILE_SIZE);
  if (px < 0) px = 0;
  if (px > TILE_SIZE - 1) px = TILE_SIZE - 1;
  if (py < 0) py = 0;
  if (py > TILE_SIZE - 1) py = TILE_SIZE - 1;
  const i = (py * TILE_SIZE + px) * 4;
  const r = data.data[i];
  const g = data.data[i + 1];
  const b = data.data[i + 2];
  return r * 256 + g + b / 256 - 32768;
}

// --- geodesy ---------------------------------------------------------------

const EARTH_R = 6371000;

function boundsAround(lat, lng, radiusM) {
  const dLat = (radiusM / EARTH_R) * (180 / Math.PI);
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

// --- glide model -----------------------------------------------------------

// For a target ground bearing θ in a wind vector (Wx east, Wy north) at airspeed V:
//   w∥(θ) = Wx sin θ + Wy cos θ     (wind component along the ground track)
//   w⊥² = |W|² − w∥²                (perpendicular component squared)
//   G(θ) = w∥ + √(V² − w⊥²)         (ground speed; impassable if w⊥ ≥ V)
// Altitude loss per metre of ground travel:
//   dh/dd = V / (GR · G(θ))
//
// Reachability is a parallel Bellman-Ford relaxation on a square grid: each
// cell stores the highest altitude any path can deliver the pilot to; each
// iteration, every cell in parallel reads its 8 neighbours and takes
//   best = max(self, neighbour_alt − altLoss[neighbour→self])
// stopping when the result would be below terrain. Runs on the GPU.

const MIN_CELL_M = 100;             // finest grid cell size (m)
const MAX_RANGE_M = 150_000;        // hard cap on search radius
const GRID_BUDGET = 400;            // targets ~(2*400+1)² = ~800² cells
// 16-connected template: 8 king moves + 8 knight-like moves. The knight moves
// add directions at ~26.6° and ~63.4°, which cuts the octagonal anisotropy of
// an 8-only grid from ~8% worst-case to ~2% (the reachable set approaches a
// smooth circle in flat terrain).
const NEIGHBOR_DX = [
  -1, 1,  0,  0, -1,  1, -1, 1,
  -2, 2, -2,  2, -1,  1, -1, 1,
];
const NEIGHBOR_DY = [
   0, 0, -1,  1, -1, -1,  1, 1,
  -1, -1, 1,  1, -2, -2,  2, 2,
];
const N_NEIGHBORS = 16;

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

let computeToken = 0;
let debounceHandle = null;
let flooder = null;
let lastBaseElevM = null;

function scheduleCompute(delayMs = 300) {
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    if (pinLngLat) compute();
  }, delayMs);
  scheduleUrlWrite();
}

// --- URL state -------------------------------------------------------------

let urlWriteTimer = null;

function scheduleUrlWrite() {
  if (urlWriteTimer) clearTimeout(urlWriteTimer);
  urlWriteTimer = setTimeout(writeUrl, 250);
}

function writeUrl() {
  const parts = [];
  if (pinLngLat) {
    parts.push(`pin=${pinLngLat.lat.toFixed(5)},${pinLngLat.lng.toFixed(5)}`);
  }
  parts.push(`alt=${document.getElementById('height').value}`);
  parts.push(`au=${document.getElementById('heightUnit').value}`);
  parts.push(`gr=${document.getElementById('gr').value}`);
  parts.push(`as=${document.getElementById('airspeed').value}`);
  parts.push(`ws=${document.getElementById('windSpeed').value}`);
  parts.push(`wd=${document.getElementById('windDir').value}`);
  if (document.getElementById('compareFixed').checked) parts.push('cmp=1');
  const c = map.getCenter();
  parts.push(`c=${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
  parts.push(`z=${map.getZoom().toFixed(2)}`);
  history.replaceState(null, '', '#' + parts.join('&'));
}

function readUrl() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  const state = {};
  for (const seg of raw.split('&')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    state[seg.slice(0, eq)] = decodeURIComponent(seg.slice(eq + 1));
  }
  return state;
}

function applyUrlState() {
  const s = readUrl();
  if (!s) return;

  const setIfValid = (id, v) => {
    if (v !== undefined && v !== '') document.getElementById(id).value = v;
  };
  setIfValid('height', s.alt);
  setIfValid('heightUnit', s.au);
  setIfValid('gr', s.gr);
  setIfValid('airspeed', s.as);
  setIfValid('windSpeed', s.ws);
  setIfValid('windDir', s.wd);
  if (s.cmp === '1') document.getElementById('compareFixed').checked = true;

  // Nudge the compass arrow to match wd.
  if (s.wd !== undefined) {
    const ev = new Event('input', { bubbles: true });
    document.getElementById('windDir').dispatchEvent(ev);
  }

  if (s.c) {
    const [lat, lng] = s.c.split(',').map(parseFloat);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const zoom = s.z ? parseFloat(s.z) : map.getZoom();
      map.jumpTo({ center: [lng, lat], zoom: Number.isFinite(zoom) ? zoom : map.getZoom() });
    }
  }

  if (s.pin) {
    const [lat, lng] = s.pin.split(',').map(parseFloat);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setPin({ lng, lat });
    }
  }
}

async function compute() {
  if (!pinLngLat) {
    setStatus('Click the map to set a pin first.');
    return;
  }
  const myToken = ++computeToken;
  const altRaw = parseFloat(document.getElementById('height').value);
  const altUnit = document.getElementById('heightUnit').value;
  const altMSL = altUnit === 'ft' ? altRaw * 0.3048 : altRaw;
  const GR = parseFloat(document.getElementById('gr').value);
  const V = parseFloat(document.getElementById('airspeed').value) / 3.6; // m/s
  const W = parseFloat(document.getElementById('windSpeed').value) / 3.6; // m/s
  const windFromDeg = parseFloat(document.getElementById('windDir').value);

  if (!(altMSL > 0) || !(GR > 0) || !(V > 0)) {
    setStatus('Check altitude, glide ratio, and airspeed — must be > 0.');
    return;
  }

  setStatus('Loading terrain tiles…');

  // Wind vector in ground frame. "Wind from D°" means parcels move toward D+180°.
  const windToRad = ((windFromDeg + 180) * Math.PI) / 180;
  const Wx = W * Math.sin(windToRad);
  const Wy = W * Math.cos(windToRad);

  const { lat, lng } = pinLngLat;

  await preloadTilesForBounds(boundsAround(lat, lng, 500));
  if (myToken !== computeToken) return;
  const baseElev = elevationAt(lat, lng);
  if (baseElev === null) {
    setStatus('Terrain tile missing — try again.');
    return;
  }
  lastBaseElevM = baseElev;
  refreshHeightSlider();

  const heightAboveLaunch = altMSL - baseElev;
  if (heightAboveLaunch <= 0) {
    setStatus(
      `Altitude ${altMSL.toFixed(0)} m MSL is below terrain at pin (${baseElev.toFixed(0)} m) — you're on the ground.`,
    );
    map.getSource('glide').setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  // Worst-case tailwind range for grid sizing. Uses altMSL (not AGL) as the
  // altitude budget — the pilot can potentially descend to sea level if terrain
  // drops away from the pin, which is exactly the case where undersizing the
  // grid cuts off a real reachable region with a straight clipped edge.
  const maxRange = Math.min(
    MAX_RANGE_M,
    altMSL * GR * (1 + W / V) * 1.25 + 500,
  );

  const bounds = boundsAround(lat, lng, maxRange);
  await preloadTilesForBounds(bounds);
  if (myToken !== computeToken) return;

  const ctx = { lat, lng, altMSL, Wx, Wy, V, GR, maxRange };

  // Primary run: adaptive cell size — finer at short range, coarser at long.
  const adaptiveCell = Math.max(MIN_CELL_M, maxRange / GRID_BUDGET);
  setStatus(`Flooding (cell ${adaptiveCell | 0} m)…`);
  await new Promise((r) => requestAnimationFrame(r));
  if (myToken !== computeToken) return;

  let primary;
  try {
    primary = runFlood(ctx, adaptiveCell);
  } catch (err) {
    setStatus('GPU flood failed: ' + err.message);
    return;
  }
  if (myToken !== computeToken) return;
  map.getSource('glide').setData(primary.geojson);

  // Optional comparison overlay: fixed 100 m grid, outline only.
  const compareOn = document.getElementById('compareFixed').checked;
  let compareStatus = '';
  if (compareOn && adaptiveCell > MIN_CELL_M) {
    setStatus(`Running compare flood (cell 100 m)…`);
    await new Promise((r) => requestAnimationFrame(r));
    if (myToken !== computeToken) return;
    try {
      const compare = runFlood(ctx, 100);
      map.getSource('glide-compare').setData(compare.geojson);
      compareStatus =
        ` | fixed-100m ${compare.nx}×${compare.ny} ` +
        `t${compare.timings.terrain | 0} g${compare.timings.gpu | 0}`;
    } catch (err) {
      compareStatus = ' | compare failed: ' + err.message;
    }
  } else {
    map.getSource('glide-compare').setData({ type: 'FeatureCollection', features: [] });
  }

  const t = primary.timings;
  setStatus(
    `cell ${adaptiveCell | 0} m, ${primary.nx}×${primary.ny}, ` +
    `${primary.polyCount} poly — ` +
    `t${t.terrain | 0} g${t.gpu | 0} c${t.contour | 0}ms` +
    compareStatus,
  );
}

function runFlood(ctx, cellM) {
  const { lat, lng, altMSL, Wx, Wy, V, GR, maxRange } = ctx;
  const n = Math.ceil(maxRange / cellM);
  const nx = 2 * n + 1;
  const ny = 2 * n + 1;

  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degPerMLat = 180 / Math.PI / EARTH_R;
  const degPerMLng = degPerMLat / cosLat;

  const t0 = performance.now();
  const terrain = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const latJ = lat + (j - n) * cellM * degPerMLat;
    for (let i = 0; i < nx; i++) {
      const lngI = lng + (i - n) * cellM * degPerMLng;
      const e = elevationAt(latJ, lngI);
      terrain[j * nx + i] = e === null || Number.isNaN(e) ? 99999 : e;
    }
  }

  // Per-neighbour altitude loss for movement FROM neighbour TO self:
  // edge direction is (−dx, −dy) in (east, north) cell units.
  const altLoss = new Float32Array(N_NEIGHBORS);
  const BIG = 1e9;
  for (let k = 0; k < N_NEIGHBORS; k++) {
    const dE = -NEIGHBOR_DX[k] * cellM;
    const dN = -NEIGHBOR_DY[k] * cellM;
    const dist = Math.sqrt(dE * dE + dN * dN);
    const bearing = Math.atan2(dE, dN);
    const wPar = Wx * Math.sin(bearing) + Wy * Math.cos(bearing);
    const wPerpSq = Wx * Wx + Wy * Wy - wPar * wPar;
    if (wPerpSq >= V * V) { altLoss[k] = BIG; continue; }
    const G = wPar + Math.sqrt(V * V - wPerpSq);
    if (G <= 0.01) { altLoss[k] = BIG; continue; }
    altLoss[k] = (dist * V) / (GR * G);
  }

  const t1 = performance.now();
  if (!flooder) flooder = new GpuFlooder();
  const iterations = Math.ceil(n * 1.8 + 20);
  const result = flooder.flood({
    nx, ny, terrain, altLoss,
    pinI: n, pinJ: n, altMSL, iterations,
  });
  const t2 = performance.now();

  const field = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    field[k] = result[k] < -1e8 ? -1 : result[k] - terrain[k];
  }

  const contourResult = d3.contours().size([nx, ny]).thresholds([0])(field);
  const mp = contourResult[0];

  const coords = mp.coordinates.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([i, j]) => [
        lng + (i - n) * cellM * degPerMLng,
        lat + (j - n) * cellM * degPerMLat,
      ]),
    ),
  );
  const t3 = performance.now();

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: coords },
        properties: {},
      }],
    },
    nx, ny, polyCount: coords.length,
    timings: { terrain: t1 - t0, gpu: t2 - t1, contour: t3 - t2 },
  };
}

function clearPolygon() {
  if (map.getSource('glide')) {
    map.getSource('glide').setData({ type: 'FeatureCollection', features: [] });
  }
  if (pinMarker) {
    pinMarker.remove();
    pinMarker = null;
    pinLngLat = null;
    document.getElementById('coords').textContent = '(not set — click map)';
  }
  setStatus('');
  scheduleUrlWrite();
}

document.getElementById('clear').addEventListener('click', clearPolygon);

// Auto-recompute on form changes.
['height', 'gr', 'airspeed', 'windSpeed', 'windDir'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => scheduleCompute());
});
document.getElementById('heightUnit').addEventListener('change', () => {
  refreshHeightSlider();
  scheduleCompute();
});
document.getElementById('compareFixed').addEventListener('change', () => scheduleCompute(0));

// --- height slider ↔ number sync ------------------------------------------

const MAX_ALT_FT = 18000;
const MAX_ALT_M = MAX_ALT_FT * 0.3048; // ≈ 5486.4 m

function refreshHeightSlider() {
  const slider = document.getElementById('heightSlider');
  const number = document.getElementById('height');
  const unit = document.getElementById('heightUnit').value;
  const floorM = lastBaseElevM != null ? Math.max(0, Math.ceil(lastBaseElevM)) : 0;
  if (unit === 'ft') {
    slider.min = String(Math.ceil(floorM / 0.3048));
    slider.max = String(MAX_ALT_FT);
    slider.step = '50';
  } else {
    slider.min = String(floorM);
    slider.max = String(Math.ceil(MAX_ALT_M));
    slider.step = '10';
  }
  const v = parseFloat(number.value);
  if (!Number.isNaN(v)) {
    const clamped = Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), v));
    slider.value = String(clamped);
    if (clamped !== v) number.value = String(clamped);
  }
  const hint = document.getElementById('heightHint');
  if (lastBaseElevM != null) {
    const f = unit === 'ft' ? slider.min : `${slider.min} m`;
    hint.textContent =
      unit === 'ft'
        ? `Slider: ${slider.min} – ${MAX_ALT_FT} ft (pin terrain → 18 k ft).`
        : `Slider: ${slider.min} – ${slider.max} m (pin terrain → 18 k ft).`;
  }
}

document.getElementById('heightSlider').addEventListener('input', (e) => {
  const number = document.getElementById('height');
  number.value = e.target.value;
  scheduleCompute();
});
document.getElementById('height').addEventListener('input', (e) => {
  const slider = document.getElementById('heightSlider');
  slider.value = e.target.value;
});
refreshHeightSlider();

// --- compass rose ----------------------------------------------------------

(function initCompass() {
  const svg = document.getElementById('compass');
  const arrow = document.getElementById('windArrow');
  const input = document.getElementById('windDir');
  const ticksGroup = document.getElementById('compassTicks');
  const ARROW_R = 38;

  // Ticks every 30°, longer every 90°.
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    const outer = 60;
    const inner = deg % 90 === 0 ? 52 : 56;
    const x1 = Math.sin(rad) * inner;
    const y1 = -Math.cos(rad) * inner;
    const x2 = Math.sin(rad) * outer;
    const y2 = -Math.cos(rad) * outer;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    ticksGroup.appendChild(line);
  }

  function drawArrow(deg) {
    const rad = (deg * Math.PI) / 180;
    const fromX = Math.sin(rad) * ARROW_R;
    const fromY = -Math.cos(rad) * ARROW_R;
    arrow.setAttribute('x1', fromX);
    arrow.setAttribute('y1', fromY);
    arrow.setAttribute('x2', -fromX);
    arrow.setAttribute('y2', -fromY);
  }

  function normalizeDeg(d) {
    d = d % 360;
    if (d < 0) d += 360;
    return d;
  }

  function pointerToDeg(e) {
    const rect = svg.getBoundingClientRect();
    // SVG viewBox is -80..80 on each axis; map pointer into that frame.
    const vx = ((e.clientX - rect.left) / rect.width) * 160 - 80;
    const vy = ((e.clientY - rect.top) / rect.height) * 160 - 80;
    const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
    return normalizeDeg(Math.round(deg));
  }

  let dragging = false;

  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    const d = pointerToDeg(e);
    input.value = d;
    drawArrow(d);
    scheduleCompute();
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const d = pointerToDeg(e);
    input.value = d;
    drawArrow(d);
    scheduleCompute();
  });
  svg.addEventListener('pointerup', (e) => {
    dragging = false;
    try { svg.releasePointerCapture(e.pointerId); } catch {}
  });
  svg.addEventListener('pointercancel', () => { dragging = false; });

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) drawArrow(normalizeDeg(v));
  });

  drawArrow(normalizeDeg(parseFloat(input.value) || 0));
})();

// --- GPU flood -------------------------------------------------------------

class GpuFlooder {
  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float not available (needed for R32F render targets)');
    }
    this.gl = gl;
    this.canvas = canvas;

    const vs = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

    const fs = `#version 300 es
precision highp float;
uniform highp sampler2D u_alt;
uniform highp sampler2D u_terrain;
uniform vec2 u_texel;
uniform float u_loss[16];
in vec2 v_uv;
out vec4 outColor;

const vec2 OFFS[16] = vec2[](
  vec2(-1.0,  0.0), vec2( 1.0,  0.0),
  vec2( 0.0, -1.0), vec2( 0.0,  1.0),
  vec2(-1.0, -1.0), vec2( 1.0, -1.0),
  vec2(-1.0,  1.0), vec2( 1.0,  1.0),
  vec2(-2.0, -1.0), vec2( 2.0, -1.0),
  vec2(-2.0,  1.0), vec2( 2.0,  1.0),
  vec2(-1.0, -2.0), vec2( 1.0, -2.0),
  vec2(-1.0,  2.0), vec2( 1.0,  2.0)
);

void main() {
  float self = texture(u_alt, v_uv).r;
  float terrain = texture(u_terrain, v_uv).r;
  float best = self;
  for (int k = 0; k < 16; k++) {
    float loss = u_loss[k];
    if (loss > 1e8) continue;
    float nAlt = texture(u_alt, v_uv + OFFS[k] * u_texel).r;
    if (nAlt < -1e8) continue;
    float arrival = nAlt - loss;
    if (arrival > terrain && arrival > best) best = arrival;
  }
  outColor = vec4(best, 0.0, 0.0, 1.0);
}`;

    this.prog = this._makeProgram(vs, fs);
    this.uLoss = gl.getUniformLocation(this.prog, 'u_loss');
    this.uTexel = gl.getUniformLocation(this.prog, 'u_texel');
    this.uAlt = gl.getUniformLocation(this.prog, 'u_alt');
    this.uTerrain = gl.getUniformLocation(this.prog, 'u_terrain');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(this.prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.fbo = gl.createFramebuffer();
  }

  _makeShader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile: ' + log);
    }
    return s;
  }

  _makeProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._makeShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, this._makeShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link: ' + log);
    }
    return p;
  }

  _makeTex(nx, ny, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, data);
    return t;
  }

  flood({ nx, ny, terrain, altLoss, pinI, pinJ, altMSL, iterations }) {
    const gl = this.gl;
    this.canvas.width = nx;
    this.canvas.height = ny;

    const terrainTex = this._makeTex(nx, ny, terrain);

    const altInit = new Float32Array(nx * ny);
    altInit.fill(-1e9);
    altInit[pinJ * nx + pinI] = altMSL;
    let texA = this._makeTex(nx, ny, altInit);
    let texB = this._makeTex(nx, ny, null);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform1fv(this.uLoss, altLoss);
    gl.uniform2f(this.uTexel, 1 / nx, 1 / ny);
    gl.uniform1i(this.uAlt, 0);
    gl.uniform1i(this.uTerrain, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, terrainTex);
    gl.viewport(0, 0, nx, ny);

    for (let i = 0; i < iterations; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texB, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      [texA, texB] = [texB, texA];
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
    const out = new Float32Array(nx * ny);
    gl.readPixels(0, 0, nx, ny, gl.RED, gl.FLOAT, out);

    gl.deleteTexture(terrainTex);
    gl.deleteTexture(texA);
    gl.deleteTexture(texB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return out;
  }
}
