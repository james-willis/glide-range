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

function destinationPoint(lat, lng, bearingDeg, distM) {
  const δ = distM / EARTH_R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2,
    );
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

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
//   G(θ) = w∥ + √(V² − w⊥²)         (ground speed; NaN if w⊥ > V → can't make that bearing)
// Altitude loss per metre of ground travel in direction θ:
//   dh/dd = V / (GR · G(θ))

const BEARINGS = 180;
const STEP_M = 60;
const MAX_RAY_M = 60000;

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

let computeToken = 0;
let debounceHandle = null;

function scheduleCompute(delayMs = 300) {
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    if (pinLngLat) compute();
  }, delayMs);
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

  const btn = document.getElementById('compute');
  btn.disabled = true;
  setStatus('Loading terrain tiles…');

  // Wind vector in ground frame. "Wind from D°" means air parcels move toward D+180°.
  const windToRad = ((windFromDeg + 180) * Math.PI) / 180;
  const Wx = W * Math.sin(windToRad); // east
  const Wy = W * Math.cos(windToRad); // north

  const { lat, lng } = pinLngLat;

  // Need terrain under the pin first, to size the range estimate and
  // sanity-check that the pilot is airborne.
  await preloadTilesForBounds(boundsAround(lat, lng, 500));
  if (myToken !== computeToken) return;
  const baseElev = elevationAt(lat, lng);
  if (baseElev === null) {
    setStatus('Terrain tile missing — try again.');
    btn.disabled = false;
    return;
  }
  const heightAboveLaunch = altMSL - baseElev;
  if (heightAboveLaunch <= 0) {
    setStatus(
      `Altitude ${altMSL.toFixed(0)} m MSL is below terrain at pin (${baseElev.toFixed(0)} m) — you're on the ground.`,
    );
    map.getSource('glide').setData({ type: 'FeatureCollection', features: [] });
    btn.disabled = false;
    return;
  }

  // Worst-case tailwind range for bounds estimate.
  const maxRange = Math.min(
    MAX_RAY_M,
    heightAboveLaunch * GR * (1 + W / V) * 1.15 + 500,
  );

  const bounds = boundsAround(lat, lng, maxRange);
  await preloadTilesForBounds(bounds);

  if (myToken !== computeToken) return; // a newer compute has started

  const startAbsAlt = altMSL;

  setStatus('Tracing rays…');
  // Yield to the UI once before the sync compute.
  await new Promise((r) => requestAnimationFrame(r));

  if (myToken !== computeToken) return;

  const ring = [];
  let blockedBearings = 0;

  for (let i = 0; i < BEARINGS; i++) {
    const bearing = (i * 360) / BEARINGS;
    const θ = (bearing * Math.PI) / 180;
    const wPar = Wx * Math.sin(θ) + Wy * Math.cos(θ);
    const wPerpSq = Wx * Wx + Wy * Wy - wPar * wPar;

    if (wPerpSq >= V * V) {
      // Crosswind exceeds airspeed — can't crab to this track.
      ring.push([lng, lat]);
      blockedBearings++;
      continue;
    }
    const G = wPar + Math.sqrt(V * V - wPerpSq);
    if (G <= 0.01) {
      ring.push([lng, lat]);
      blockedBearings++;
      continue;
    }
    const altLossPerM = V / (GR * G);

    let d = 0;
    let lastLng = lng;
    let lastLat = lat;

    while (d < MAX_RAY_M) {
      d += STEP_M;
      const altAtD = startAbsAlt - d * altLossPerM;
      const pt = destinationPoint(lat, lng, bearing, d);
      const terrain = elevationAt(pt.lat, pt.lng);
      if (terrain === null) break;
      if (altAtD <= terrain) {
        lastLng = pt.lng;
        lastLat = pt.lat;
        break;
      }
      lastLng = pt.lng;
      lastLat = pt.lat;
      if (altAtD <= 0) break; // sanity
    }
    ring.push([lastLng, lastLat]);
  }

  ring.push(ring[0]);

  if (myToken !== computeToken) return; // newer compute superseded us

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {},
      },
    ],
  };
  map.getSource('glide').setData(geojson);

  const msg =
    blockedBearings > 0
      ? `Done. ${blockedBearings}/${BEARINGS} bearings blocked (crosswind > airspeed).`
      : `Done. ${BEARINGS} rays traced.`;
  setStatus(msg);
  btn.disabled = false;
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
}

document.getElementById('compute').addEventListener('click', () => scheduleCompute(0));
document.getElementById('clear').addEventListener('click', clearPolygon);

// Auto-recompute on form changes.
['height', 'gr', 'airspeed', 'windSpeed', 'windDir'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => scheduleCompute());
});
document.getElementById('heightUnit').addEventListener('change', () => scheduleCompute());

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
