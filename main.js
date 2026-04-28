// glide-range: terrain + wind-aware paraglider reach estimator

// Toggle to swap the GPU compute backend. WebGPU branch is experimental — the
// map renderer (MapLibre GL) is still WebGL2 either way; this only affects the
// flood-fill / terrain-bake compute path.
const USE_WEBGPU = true;

// --- map setup --------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-122.0306, 47.5133], // Poo Poo Point LZ, Tiger Mountain
  zoom: 13,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let pinMarker = null;
let pinLngLat = null;
let lastCompute = null; // stored for click-to-query AGL

// AGL beyond this caps at the deepest-green colour. Gives good dynamic range
// for typical paragliding scenarios without washing everything out at 18k ft.
const MAX_AGL_M = 2500;

// Smooth RdYlGn ramp: red = barely, green = plenty. Built at module load into
// a 256-entry LUT for O(1) pixel-time lookup.
const RAMP_STOPS = [
  [0.00, 165,   0,  38],
  [0.10, 215,  48,  39],
  [0.25, 244, 109,  67],
  [0.45, 254, 224, 139],
  [0.50, 255, 255, 191],
  [0.55, 217, 239, 139],
  [0.75, 102, 189,  99],
  [0.90,  26, 152,  80],
  [1.00,   0, 104,  55],
];
const COLOR_RAMP = (() => {
  const n = 256;
  const lut = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let a = 0;
    while (a < RAMP_STOPS.length - 1 && RAMP_STOPS[a + 1][0] < t) a++;
    const s0 = RAMP_STOPS[a];
    const s1 = RAMP_STOPS[Math.min(RAMP_STOPS.length - 1, a + 1)];
    const lt = (t - s0[0]) / Math.max(1e-9, s1[0] - s0[0]);
    lut[i * 3 + 0] = Math.round(s0[1] + (s1[1] - s0[1]) * lt);
    lut[i * 3 + 1] = Math.round(s0[2] + (s1[2] - s0[2]) * lt);
    lut[i * 3 + 2] = Math.round(s0[3] + (s1[3] - s0[3]) * lt);
  }
  return lut;
})();

map.on('click', handleMapClick);

function sampleAt(lngLat) {
  if (!lastCompute) return null;
  const { field, terrain, nx, ny, n, lat: pLat, lng: pLng, cellM, degPerMLat, degPerMLng } = lastCompute;
  const dE = (lngLat.lng - pLng) / degPerMLng;
  const dN = (lngLat.lat - pLat) / degPerMLat;
  const i = Math.round(n + dE / cellM);
  const j = Math.round(n + dN / cellM);
  if (i < 0 || i >= nx || j < 0 || j >= ny) return null;
  const agl = field[j * nx + i];
  if (agl < 0) return null;
  const ground = terrain[j * nx + i];
  return { agl, msl: ground + agl };
}

// Rolling queue of in-flight blob URLs. MapLibre fetches URLs asynchronously,
// so we can't revoke immediately after updateImage — keep the two most recent
// alive until a third arrives.
const rasterUrlQueue = [];

async function updateRasterSource(imageData, coordinates) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  map.getSource('glide-raster').updateImage({ url, coordinates });
  rasterUrlQueue.push(url);
  while (rasterUrlQueue.length > 2) {
    URL.revokeObjectURL(rasterUrlQueue.shift());
  }
}

function handleMapClick(e) {
  setPin(e.lngLat);
}

// Hover tooltip for AGL at cursor. Reuses a single Popup so it follows the
// mouse without flicker.
const hoverPopup = new maplibregl.Popup({
  closeButton: false,
  closeOnClick: false,
  offset: 12,
});

function handleMapMouseMove(e) {
  const s = sampleAt(e.lngLat);
  if (s == null) {
    hoverPopup.remove();
    map.getCanvas().style.cursor = '';
    return;
  }
  const unit = document.getElementById('heightUnit').value;
  const fmt = (m) => unit === 'ft' ? `${(m / 0.3048).toFixed(0)} ft` : `${m.toFixed(0)} m`;
  hoverPopup
    .setLngLat(e.lngLat)
    .setHTML(`<div class="hover-readout">${fmt(s.msl)} MSL<br/>${fmt(s.agl)} AGL</div>`)
    .addTo(map);
  map.getCanvas().style.cursor = 'crosshair';
}

function handleMapMouseLeave() {
  hoverPopup.remove();
  map.getCanvas().style.cursor = '';
}

map.on('mousemove', handleMapMouseMove);
map.on('mouseout', handleMapMouseLeave);

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
  // Insert our layers BEFORE the first label (symbol) layer from the loaded
  // OpenFreeMap style, so place/peak/water names stay on top.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol');
  const beforeId = firstSymbol ? firstSymbol.id : undefined;

  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: [
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    ],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution:
      'Terrain © <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
  });
  map.addLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'terrain-dem',
    paint: {
      'hillshade-exaggeration': 0.55,
      'hillshade-shadow-color': '#4a3e28',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#000000',
      'hillshade-illumination-direction': 335,
    },
  }, beforeId);

  // Continuous AGL colouring via a raster image. One pixel per grid cell;
  // colours come from the RdYlGn LUT. Bilinear resampling keeps it smooth at
  // zoom-in.
  const PLACEHOLDER_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  map.addSource('glide-raster', {
    type: 'image',
    url: PLACEHOLDER_PNG,
    coordinates: [[-1, 1], [1, 1], [1, -1], [-1, -1]],
  });
  map.addLayer({
    id: 'glide-raster-layer',
    type: 'raster',
    source: 'glide-raster',
    paint: {
      'raster-opacity': 0.55,
      'raster-fade-duration': 0,
      'raster-resampling': 'linear',
    },
  }, beforeId);

  // Custom labels pulled straight from the OpenMapTiles vector source — the
  // default Positron style is stingy about peaks and water names. Added on
  // top of everything so they remain legible over the AGL raster.
  if (map.getSource('openmaptiles')) {
    const existingSymbol = map.getStyle().layers.find(
      (l) => l.type === 'symbol' && l.layout && l.layout['text-font'],
    );
    const fontStack = existingSymbol
      ? existingSymbol.layout['text-font']
      : ['Noto Sans Regular'];

    map.addLayer({
      id: 'peak-labels',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'mountain_peak',
      minzoom: 7,
      filter: ['has', 'name'],
      layout: {
        'text-field': [
          'concat',
          ['coalesce', ['get', 'name_en'], ['get', 'name'], ''],
          ['case',
            ['has', 'ele'],
            ['concat', '\n', ['to-string', ['get', 'ele']], ' m'],
            '',
          ],
        ],
        'text-font': fontStack,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
        'text-anchor': 'top',
        'text-offset': [0, 0.3],
        'text-justify': 'center',
        'text-max-width': 8,
        'symbol-sort-key': ['-', 10000, ['coalesce', ['get', 'ele'], 0]],
      },
      paint: {
        'text-color': '#3c2f14',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });

    map.addLayer({
      id: 'water-name-labels',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      minzoom: 7,
      filter: ['all', ['has', 'name'], ['==', ['geometry-type'], 'Point']],
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
        'text-font': fontStack,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
        'text-max-width': 8,
        'text-justify': 'center',
        'text-transform': 'none',
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': '#2a5b7a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.3,
      },
    });
  }

  applyUrlState();
});

// Persist map pan/zoom in the URL too, after any user-initiated move.
map.on('moveend', (e) => {
  if (e.originalEvent) scheduleUrlWrite();
});

// Sidebar show/hide.
(function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const setIcon = () => {
    toggle.textContent = document.body.classList.contains('sidebar-hidden')
      ? '☰'
      : '‹';
  };
  toggle.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-hidden');
    setIcon();
  });
  sidebar.addEventListener('transitionend', () => map.resize());
  setIcon();
})();

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

  setStatus('');

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
    clearRaster();
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
  await new Promise((r) => requestAnimationFrame(r));
  if (myToken !== computeToken) return;

  let primary;
  try {
    primary = await runFlood(ctx, adaptiveCell);
  } catch (err) {
    setStatus('GPU flood failed: ' + err.message);
    return;
  }
  if (myToken !== computeToken) return;
  await updateRasterSource(primary.raster.image, primary.raster.coordinates);
  if (myToken !== computeToken) return;
  lastCompute = {
    field: primary.field,
    terrain: primary.terrain,
    nx: primary.nx,
    ny: primary.ny,
    n: primary.n,
    cellM: primary.cellM,
    degPerMLat: primary.degPerMLat,
    degPerMLng: primary.degPerMLng,
    lat, lng,
  };

  setStatus('');
}

async function runFlood(ctx, cellM) {
  const { lat, lng, altMSL, Wx, Wy, V, GR, maxRange } = ctx;
  const n = Math.ceil(maxRange / cellM);
  const nx = 2 * n + 1;
  const ny = 2 * n + 1;

  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degPerMLat = 180 / Math.PI / EARTH_R;
  const degPerMLng = degPerMLat / cosLat;

  // Tile coverage for the grid bbox (same arithmetic as preloadTilesForBounds).
  const halfDegLat = n * cellM * degPerMLat;
  const halfDegLng = n * cellM * degPerMLng;
  const tileX0 = Math.floor(lng2tileX(lng - halfDegLng, TILE_ZOOM));
  const tileXend = Math.floor(lng2tileX(lng + halfDegLng, TILE_ZOOM));
  const tileY0 = Math.floor(lat2tileY(lat + halfDegLat, TILE_ZOOM));
  const tileYend = Math.floor(lat2tileY(lat - halfDegLat, TILE_ZOOM));
  const tiles = [];
  for (let tx = tileX0; tx <= tileXend; tx++) {
    for (let ty = tileY0; ty <= tileYend; ty++) {
      tiles.push({
        tileX: tx,
        tileY: ty,
        data: tileData.get(`${TILE_ZOOM}/${tx}/${ty}`) || null,
      });
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

  if (!flooder) {
    flooder = USE_WEBGPU ? await GpuFlooderWebGPU.create() : new GpuFlooder();
  }

  const t0 = performance.now();
  const { terrainTex, terrainArr } = await flooder.bakeTerrain({
    tiles,
    tileX0, tileY0,
    tileCountX: tileXend - tileX0 + 1,
    tileCountY: tileYend - tileY0 + 1,
    tileSize: TILE_SIZE,
    nx, ny,
    pinLat: lat, pinLng: lng,
    cellM, n,
    degPerMLat, degPerMLng,
    pow2z: Math.pow(2, TILE_ZOOM),
  });

  const t1 = performance.now();
  const iterations = Math.ceil(n * 1.8 + 20);
  const { result, actualIters } = await flooder.flood({
    nx, ny, terrainTex, altLoss,
    pinI: n, pinJ: n, altMSL, iterations,
  });
  const t2 = performance.now();

  const field = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    field[k] = result[k] < -1e8 ? -1 : result[k] - terrainArr[k];
  }

  // Rasterise the AGL field: one pixel per grid cell, colour from the LUT.
  // Image row 0 is north (top) but grid j=0 is south, so flip Y on write.
  const img = new ImageData(nx, ny);
  for (let j = 0; j < ny; j++) {
    const row = ny - 1 - j;
    for (let i = 0; i < nx; i++) {
      const agl = field[j * nx + i];
      const pIdx = (row * nx + i) * 4;
      if (agl < 0) {
        img.data[pIdx + 3] = 0;
      } else {
        const t = Math.min(1, agl / MAX_AGL_M);
        const rIdx = Math.min(255, Math.floor(t * 255)) * 3;
        img.data[pIdx + 0] = COLOR_RAMP[rIdx];
        img.data[pIdx + 1] = COLOR_RAMP[rIdx + 1];
        img.data[pIdx + 2] = COLOR_RAMP[rIdx + 2];
        img.data[pIdx + 3] = 255;
      }
    }
  }

  // Geographic corners of the grid, north-west / north-east / south-east /
  // south-west (MapLibre image-source order).
  const westLng = lng + (-n) * cellM * degPerMLng;
  const eastLng = lng + (n) * cellM * degPerMLng;
  const northLat = lat + (n) * cellM * degPerMLat;
  const southLat = lat + (-n) * cellM * degPerMLat;
  const coordinates = [
    [westLng, northLat],
    [eastLng, northLat],
    [eastLng, southLat],
    [westLng, southLat],
  ];

  const t3 = performance.now();

  return {
    raster: { image: img, coordinates },
    field, terrain: terrainArr,
    nx, ny, n, cellM, degPerMLat, degPerMLng,
    iterations, actualIters,
    timings: { terrain: t1 - t0, gpu: t2 - t1, contour: t3 - t2 },
  };
}

function clearRaster() {
  if (map.getSource('glide-raster')) {
    // Move the raster off-screen with a degenerate footprint so it's
    // invisible until the next compute.
    map.getSource('glide-raster').setCoordinates([
      [-1, 1], [1, 1], [1, -1], [-1, -1],
    ]);
  }
}

// Auto-recompute on form changes.
['height', 'gr', 'airspeed', 'windSpeed', 'windDir'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => scheduleCompute());
});
document.getElementById('heightUnit').addEventListener('change', () => {
  refreshHeightSlider();
  scheduleCompute();
});

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
layout(location = 0) in vec2 a_pos;
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
  // Skip the write if the cell didn't change by more than a trivial amount —
  // occlusion queries then count only truly changed cells. The destination
  // texture has already been primed with the previous iteration's values via
  // the copy pass, so unchanged cells retain them.
  if (best <= self + 0.5) discard;
  outColor = vec4(best, 0.0, 0.0, 1.0);
}`;

    const copyFs = `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

    // Terrain bake shader: project each output cell → global terrarium pixel
    // coords → atlas sample → decode RGB to elevation.
    const bakeFs = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;      // in pixels
uniform vec2 u_atlasOriginPx;  // global terrarium pixel coords of atlas (0, 0)
uniform vec2 u_pinLL;          // (lng, lat) of pin
uniform vec2 u_degPerM;        // (degPerMLng, degPerMLat)
uniform float u_cellM;
uniform float u_n;             // half-grid size (nx = 2n+1)
uniform vec2 u_gridSize;       // (nx, ny)
uniform float u_pow2z;         // 2^TILE_ZOOM
in vec2 v_uv;
out vec4 outColor;

const float TILE_SIZE = 256.0;
const float DEG2RAD = 0.01745329;
const float PI = 3.14159265;

void main() {
  // Cell indices (i, j), with j=0 = south matching our grid convention.
  float i = floor(v_uv.x * u_gridSize.x);
  float j = floor(v_uv.y * u_gridSize.y);
  float dE = (i - u_n) * u_cellM;
  float dN = (j - u_n) * u_cellM;
  float lat = u_pinLL.y + dN * u_degPerM.y;
  float lng = u_pinLL.x + dE * u_degPerM.x;

  // Global terrarium pixel coords (z = TILE_ZOOM).
  float gx = ((lng + 180.0) / 360.0) * u_pow2z * TILE_SIZE;
  float latRad = lat * DEG2RAD;
  float tileY = (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / PI) * 0.5 * u_pow2z;
  float gy = tileY * TILE_SIZE;

  vec2 atlasUV = (vec2(gx, gy) - u_atlasOriginPx) / u_atlasSize;

  float elev;
  if (atlasUV.x < 0.0 || atlasUV.x > 1.0 || atlasUV.y < 0.0 || atlasUV.y > 1.0) {
    elev = 99999.0; // off-atlas = treat as impassable wall
  } else {
    vec4 texel = texture(u_atlas, atlasUV);
    float r = texel.r * 255.0;
    float g = texel.g * 255.0;
    float b = texel.b * 255.0;
    elev = r * 256.0 + g + b / 256.0 - 32768.0;
  }
  outColor = vec4(elev, 0.0, 0.0, 1.0);
}`;

    this.prog = this._makeProgram(vs, fs);
    this.uLoss = gl.getUniformLocation(this.prog, 'u_loss');
    this.uTexel = gl.getUniformLocation(this.prog, 'u_texel');
    this.uAlt = gl.getUniformLocation(this.prog, 'u_alt');
    this.uTerrain = gl.getUniformLocation(this.prog, 'u_terrain');

    this.copyProg = this._makeProgram(vs, copyFs);
    this.uCopySrc = gl.getUniformLocation(this.copyProg, 'u_src');

    this.bakeProg = this._makeProgram(vs, bakeFs);
    this.uBake = {
      atlas: gl.getUniformLocation(this.bakeProg, 'u_atlas'),
      atlasSize: gl.getUniformLocation(this.bakeProg, 'u_atlasSize'),
      atlasOriginPx: gl.getUniformLocation(this.bakeProg, 'u_atlasOriginPx'),
      pinLL: gl.getUniformLocation(this.bakeProg, 'u_pinLL'),
      degPerM: gl.getUniformLocation(this.bakeProg, 'u_degPerM'),
      cellM: gl.getUniformLocation(this.bakeProg, 'u_cellM'),
      n: gl.getUniformLocation(this.bakeProg, 'u_n'),
      gridSize: gl.getUniformLocation(this.bakeProg, 'u_gridSize'),
      pow2z: gl.getUniformLocation(this.bakeProg, 'u_pow2z'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.fbo = gl.createFramebuffer();

    // Serializes overlapping flood() calls so they can't stomp GL state.
    this._chain = Promise.resolve();
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

  flood(opts) {
    const prev = this._chain;
    this._chain = (async () => {
      await prev.catch(() => {});
      return this._flood(opts);
    })();
    return this._chain;
  }

  async bakeTerrain({ tiles, tileX0, tileY0, tileCountX, tileCountY, tileSize, nx, ny, pinLat, pinLng, cellM, n, degPerMLat, degPerMLng, pow2z }) {
    const gl = this.gl;
    const atlasW = tileCountX * tileSize;
    const atlasH = tileCountY * tileSize;
    this.canvas.width = nx;
    this.canvas.height = ny;

    // Atlas texture: composited terrarium-encoded tiles. RGBA8 storage.
    const atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlasW, atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const { tileX, tileY, data } of tiles) {
      if (!data) continue;
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        (tileX - tileX0) * tileSize,
        (tileY - tileY0) * tileSize,
        gl.RGBA, gl.UNSIGNED_BYTE, data,
      );
    }

    const terrainTex = this._makeTex(nx, ny, null);

    gl.useProgram(this.bakeProg);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.uBake.atlas, 0);
    gl.uniform2f(this.uBake.atlasSize, atlasW, atlasH);
    gl.uniform2f(this.uBake.atlasOriginPx, tileX0 * tileSize, tileY0 * tileSize);
    gl.uniform2f(this.uBake.pinLL, pinLng, pinLat);
    gl.uniform2f(this.uBake.degPerM, degPerMLng, degPerMLat);
    gl.uniform1f(this.uBake.cellM, cellM);
    gl.uniform1f(this.uBake.n, n);
    gl.uniform2f(this.uBake.gridSize, nx, ny);
    gl.uniform1f(this.uBake.pow2z, pow2z);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, terrainTex, 0);
    gl.viewport(0, 0, nx, ny);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Readback terrain — CPU still needs it for rasterising AGL and hover.
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, nx * ny * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, nx, ny, gl.RED, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    try {
      await this._waitFence(fence);
    } finally {
      gl.deleteSync(fence);
    }

    const terrainArr = new Float32Array(nx * ny);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, terrainArr);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(pbo);
    gl.deleteTexture(atlasTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { terrainTex, terrainArr };
  }

  async _flood({ nx, ny, terrainTex, altLoss, pinI, pinJ, altMSL, iterations }) {
    const gl = this.gl;
    this.canvas.width = nx;
    this.canvas.height = ny;

    const altInit = new Float32Array(nx * ny);
    altInit.fill(-1e9);
    altInit[pinJ * nx + pinI] = altMSL;
    let texA = this._makeTex(nx, ny, altInit);
    let texB = this._makeTex(nx, ny, null);

    gl.bindVertexArray(this.vao);

    gl.useProgram(this.prog);
    gl.uniform1fv(this.uLoss, altLoss);
    gl.uniform2f(this.uTexel, 1 / nx, 1 / ny);
    gl.uniform1i(this.uAlt, 0);
    gl.uniform1i(this.uTerrain, 1);

    gl.useProgram(this.copyProg);
    gl.uniform1i(this.uCopySrc, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, terrainTex);
    gl.viewport(0, 0, nx, ny);

    // Per iteration: copy src→dst, then relax-with-discard wrapped in an
    // occlusion query. When a drained query reports zero fragments, no cell
    // changed anywhere — we've reached the fixed point and can stop.
    let actualIters = 0;
    const pending = [];
    outer: for (let i = 0; i < iterations; i++) {
      gl.useProgram(this.copyProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texB, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.useProgram(this.prog);
      const query = gl.createQuery();
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);

      [texA, texB] = [texB, texA];
      actualIters++;
      pending.push(query);

      while (pending.length > 0) {
        const head = pending[0];
        if (!gl.getQueryParameter(head, gl.QUERY_RESULT_AVAILABLE)) break;
        const anyPassed = gl.getQueryParameter(head, gl.QUERY_RESULT);
        gl.deleteQuery(head);
        pending.shift();
        if (!anyPassed) break outer;
      }
    }
    for (const q of pending) gl.deleteQuery(q);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);

    // Issue readback into a PBO — returns immediately; GPU fills the buffer
    // asynchronously. We then fence + poll on requestAnimationFrame so the
    // main thread stays responsive while the shader iterations finish.
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, nx * ny * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, nx, ny, gl.RED, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    try {
      await this._waitFence(fence);
    } finally {
      gl.deleteSync(fence);
    }

    const out = new Float32Array(nx * ny);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(pbo);

    gl.deleteTexture(terrainTex);
    gl.deleteTexture(texA);
    gl.deleteTexture(texB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { result: out, actualIters };
  }

  _waitFence(fence) {
    const gl = this.gl;
    return new Promise((resolve, reject) => {
      const check = () => {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          resolve();
        } else if (status === gl.WAIT_FAILED) {
          reject(new Error('GL fence wait failed'));
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }
}

// ---------------------------------------------------------------------------
// GpuFlooderWebGPU — same public API as GpuFlooder, implemented with WebGPU
// compute shaders instead of fragment-shader-as-compute. Conceptual map:
//
//   WebGL                              WebGPU
//   -----                              ------
//   fragment shader on a fullscreen    @compute shader, dispatched directly
//     quad writing to an FBO           into a workgroup grid
//   R32F texture                       array<f32> storage buffer
//   uniform location set per draw      uniform/storage bind groups
//   gl.readPixels + fenceSync poll     buffer.mapAsync(GPUMapMode.READ)
//   ANY_SAMPLES_PASSED occlusion query atomic<u32> counter (not used in v1)
//
// The atlas (terrarium-encoded RGB tiles) is the one place a real texture is
// still natural — we sample it once per cell during the bake. Everything else
// is a flat Float32 buffer.
// ---------------------------------------------------------------------------

const BAKE_WGSL = /* wgsl */ `
struct BakeParams {
  atlas_size: vec2<f32>,
  atlas_origin_px: vec2<f32>,
  pin_ll: vec2<f32>,        // (lng, lat)
  deg_per_m: vec2<f32>,     // (degPerMLng, degPerMLat)
  cell_m: f32,
  n: f32,
  grid_size: vec2<f32>,     // (nx, ny)
  pow2z: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var<uniform> p: BakeParams;
@group(0) @binding(2) var<storage, read_write> terrain: array<f32>;

const TILE_SIZE: f32 = 256.0;
const DEG2RAD: f32 = 0.01745329;
const PI: f32 = 3.14159265;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = u32(p.grid_size.x);
  let ny = u32(p.grid_size.y);
  if (gid.x >= nx || gid.y >= ny) { return; }

  let i = f32(gid.x);
  let j = f32(gid.y);
  let dE = (i - p.n) * p.cell_m;
  let dN = (j - p.n) * p.cell_m;
  let lat = p.pin_ll.y + dN * p.deg_per_m.y;
  let lng = p.pin_ll.x + dE * p.deg_per_m.x;

  // Global terrarium pixel coords (z = TILE_ZOOM).
  let gx = ((lng + 180.0) / 360.0) * p.pow2z * TILE_SIZE;
  let lat_rad = lat * DEG2RAD;
  let tile_y = (1.0 - log(tan(lat_rad) + 1.0 / cos(lat_rad)) / PI) * 0.5 * p.pow2z;
  let gy = tile_y * TILE_SIZE;

  let atlas_px = vec2<f32>(gx, gy) - p.atlas_origin_px;

  var elev: f32;
  if (atlas_px.x < 0.0 || atlas_px.x >= p.atlas_size.x ||
      atlas_px.y < 0.0 || atlas_px.y >= p.atlas_size.y) {
    elev = 99999.0;  // off-atlas = impassable wall
  } else {
    // textureLoad takes integer pixel coords; no sampler, no derivatives —
    // exactly what a compute shader can express.
    let texel = textureLoad(atlas, vec2<i32>(atlas_px), 0);
    let r = texel.r * 255.0;
    let g = texel.g * 255.0;
    let b = texel.b * 255.0;
    elev = r * 256.0 + g + b / 256.0 - 32768.0;
  }
  terrain[gid.y * nx + gid.x] = elev;
}
`;

const FLOOD_WGSL = /* wgsl */ `
// 16 loss values, packed as 4 vec4s (uniform arrays of scalars have a 16-byte
// stride in WGSL — packing into vec4 keeps it tight).
@group(0) @binding(0) var<uniform> loss_packed: array<vec4<f32>, 4>;
@group(0) @binding(1) var<uniform> dims: vec4<u32>;     // (nx, ny, _, _)
@group(0) @binding(2) var<storage, read> terrain: array<f32>;

@group(1) @binding(0) var<storage, read> alt_in: array<f32>;
@group(1) @binding(1) var<storage, read_write> alt_out: array<f32>;

const BIG: f32 = 1e8;

const OFFS: array<vec2<i32>, 16> = array<vec2<i32>, 16>(
  vec2<i32>(-1,  0), vec2<i32>( 1,  0),
  vec2<i32>( 0, -1), vec2<i32>( 0,  1),
  vec2<i32>(-1, -1), vec2<i32>( 1, -1),
  vec2<i32>(-1,  1), vec2<i32>( 1,  1),
  vec2<i32>(-2, -1), vec2<i32>( 2, -1),
  vec2<i32>(-2,  1), vec2<i32>( 2,  1),
  vec2<i32>(-1, -2), vec2<i32>( 1, -2),
  vec2<i32>(-1,  2), vec2<i32>( 1,  2)
);

fn loss_at(k: u32) -> f32 {
  return loss_packed[k / 4u][k % 4u];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = dims.x;
  let ny = dims.y;
  if (gid.x >= nx || gid.y >= ny) { return; }

  let i = i32(gid.x);
  let j = i32(gid.y);
  let self_idx = gid.y * nx + gid.x;
  let self_alt = alt_in[self_idx];
  let terr = terrain[self_idx];
  var best = self_alt;

  for (var k: u32 = 0u; k < 16u; k = k + 1u) {
    let l = loss_at(k);
    if (l > BIG) { continue; }
    let off = OFFS[k];
    let ni = i + off.x;
    let nj = j + off.y;
    // Explicit bounds check replaces WebGL's CLAMP_TO_EDGE; cleaner semantics.
    if (ni < 0 || ni >= i32(nx) || nj < 0 || nj >= i32(ny)) { continue; }
    let n_alt = alt_in[u32(nj) * nx + u32(ni)];
    if (n_alt < -BIG) { continue; }
    let arrival = n_alt - l;
    if (arrival > terr && arrival > best) { best = arrival; }
  }

  // Compute can't "discard" like a fragment shader, so always write. The
  // ping-pong source already has the previous value, so unchanged cells are
  // re-written with the same value — equivalent outcome.
  alt_out[self_idx] = best;
}
`;

class GpuFlooderWebGPU {
  // WebGPU init is async (adapter request + device request) — use a factory.
  static async create() {
    if (!navigator.gpu) {
      throw new Error('WebGPU not available in this browser');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice();
    return new GpuFlooderWebGPU(device);
  }

  constructor(device) {
    this.device = device;

    const bakeModule = device.createShaderModule({ code: BAKE_WGSL });
    this.bakePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: bakeModule, entryPoint: 'main' },
    });

    const floodModule = device.createShaderModule({ code: FLOOD_WGSL });
    this.floodPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: floodModule, entryPoint: 'main' },
    });

    // Serializes overlapping flood() calls, mirroring the WebGL class.
    this._chain = Promise.resolve();
  }

  flood(opts) {
    const prev = this._chain;
    this._chain = (async () => {
      await prev.catch(() => {});
      return this._flood(opts);
    })();
    return this._chain;
  }

  // Returns { terrainTex, terrainArr } where terrainTex is a GPUBuffer (kept
  // the field name for symmetry with the WebGL backend so the caller doesn't
  // need to branch). The buffer is consumed and freed by flood().
  async bakeTerrain({ tiles, tileX0, tileY0, tileCountX, tileCountY, tileSize, nx, ny, pinLat, pinLng, cellM, n, degPerMLat, degPerMLng, pow2z }) {
    const device = this.device;
    const atlasW = tileCountX * tileSize;
    const atlasH = tileCountY * tileSize;

    // Atlas texture. COPY_DST so we can upload tile data, TEXTURE_BINDING so
    // the shader can read it.
    const atlas = device.createTexture({
      size: { width: atlasW, height: atlasH },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (const { tileX, tileY, data } of tiles) {
      if (!data) continue;
      // ImageData has Uint8ClampedArray; writeTexture takes raw bytes.
      device.queue.writeTexture(
        { texture: atlas, origin: { x: (tileX - tileX0) * tileSize, y: (tileY - tileY0) * tileSize } },
        data.data,
        { bytesPerRow: tileSize * 4, rowsPerImage: tileSize },
        { width: tileSize, height: tileSize },
      );
    }

    // Uniform buffer for bake params (64 bytes — see WGSL struct layout).
    const paramsBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const params = new Float32Array(16);
    params[0] = atlasW; params[1] = atlasH;
    params[2] = tileX0 * tileSize; params[3] = tileY0 * tileSize;
    params[4] = pinLng; params[5] = pinLat;
    params[6] = degPerMLng; params[7] = degPerMLat;
    params[8] = cellM; params[9] = n;
    params[10] = nx; params[11] = ny;
    params[12] = pow2z;
    device.queue.writeBuffer(paramsBuf, 0, params);

    // Output terrain buffer. STORAGE for the bake shader to write, COPY_SRC
    // so we can stage it out for CPU readback.
    const terrainBuf = device.createBuffer({
      size: nx * ny * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bindGroup = device.createBindGroup({
      layout: this.bakePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: atlas.createView() },
        { binding: 1, resource: { buffer: paramsBuf } },
        { binding: 2, resource: { buffer: terrainBuf } },
      ],
    });

    // CPU-readable buffer to stage the terrain back. MAP_READ + COPY_DST is
    // the only valid combo for a buffer you intend to mapAsync on.
    const readback = device.createBuffer({
      size: nx * ny * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.bakePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(nx / 8), Math.ceil(ny / 8));
    pass.end();
    enc.copyBufferToBuffer(terrainBuf, 0, readback, 0, nx * ny * 4);
    device.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const terrainArr = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    atlas.destroy();
    paramsBuf.destroy();

    // terrainBuf lives on for the flood() call.
    return { terrainTex: terrainBuf, terrainArr };
  }

  async _flood({ nx, ny, terrainTex, altLoss, pinI, pinJ, altMSL, iterations }) {
    const device = this.device;
    const cells = nx * ny;
    const terrainBuf = terrainTex; // alias for clarity (it's a GPUBuffer here)

    // Two altitude buffers for ping-pong. Initialised on the host: -1e9
    // everywhere, altMSL at the pin cell.
    const altInit = new Float32Array(cells);
    altInit.fill(-1e9);
    altInit[pinJ * nx + pinI] = altMSL;
    const bufA = device.createBuffer({
      size: cells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const bufB = device.createBuffer({
      size: cells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(bufA, 0, altInit);
    // bufB starts as a copy of bufA so unchanged cells in iter 0 already hold
    // the right value when alt_out is written.
    device.queue.writeBuffer(bufB, 0, altInit);

    // Loss vector: 16 floats, padded into 4 vec4s = 64 bytes.
    const lossPacked = new Float32Array(16);
    lossPacked.set(altLoss);
    const lossBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(lossBuf, 0, lossPacked);

    // Dims uniform: (nx, ny, 0, 0) as u32.
    const dimsBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([nx, ny, 0, 0]));

    const constsGroup = device.createBindGroup({
      layout: this.floodPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: lossBuf } },
        { binding: 1, resource: { buffer: dimsBuf } },
        { binding: 2, resource: { buffer: terrainBuf } },
      ],
    });

    // Two ping-pong bind groups, swapped each iteration. Same layout, just
    // different buffers playing the read / read_write roles.
    const groupAB = device.createBindGroup({
      layout: this.floodPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: bufA } },
        { binding: 1, resource: { buffer: bufB } },
      ],
    });
    const groupBA = device.createBindGroup({
      layout: this.floodPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: bufB } },
        { binding: 1, resource: { buffer: bufA } },
      ],
    });

    // Encode all iterations into a single command buffer. WebGPU happily
    // handles thousands of dispatches per submit; the GPU executes them
    // back-to-back without any host round-trip.
    const wgX = Math.ceil(nx / 8);
    const wgY = Math.ceil(ny / 8);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.floodPipeline);
    pass.setBindGroup(0, constsGroup);
    for (let i = 0; i < iterations; i++) {
      pass.setBindGroup(1, i % 2 === 0 ? groupAB : groupBA);
      pass.dispatchWorkgroups(wgX, wgY);
    }
    pass.end();

    // Final result lives in whichever buffer was written last.
    const finalBuf = iterations % 2 === 1 ? bufB : bufA;
    const readback = device.createBuffer({
      size: cells * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    enc.copyBufferToBuffer(finalBuf, 0, readback, 0, cells * 4);
    device.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();

    bufA.destroy();
    bufB.destroy();
    lossBuf.destroy();
    dimsBuf.destroy();
    terrainBuf.destroy();

    // Note: no early-exit on convergence. The WebGL version uses an occlusion
    // query to break out when no cell changed; that requires per-iteration
    // host syncing. WebGPU compute can do it via an atomic counter +
    // periodic mapAsync, but that means stalling the pipeline. Skipped for
    // v1 — the iteration count is bounded (~1.8n + 20) and the GPU work per
    // iteration is tiny, so running them all is fine.
    return { result: out, actualIters: iterations };
  }
}
