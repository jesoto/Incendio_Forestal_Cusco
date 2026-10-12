// Motor de análisis: busca escenas Sentinel-2 (Earth Search / AWS), arma mosaicos sin nubes
// antes y después del incendio, calcula NBR/dNBR y NDVI, clasifica severidad (USGS),
// cruza con cobertura ESA WorldCover y estima superficies afectadas.
/* global GeoTIFF, proj4 */

const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';

// Clases de severidad (dNBR x1000, Key & Benson 2006 / USGS)
export const SEVERITY = [
  { id: 0, name: 'Rebrote / sin quemar', min: -Infinity, max: 100, color: null },
  { id: 1, name: 'Severidad baja', min: 100, max: 270, color: [247, 226, 90] },
  { id: 2, name: 'Moderada-baja', min: 270, max: 440, color: [247, 152, 52] },
  { id: 3, name: 'Moderada-alta', min: 440, max: 660, color: [222, 45, 38] },
  { id: 4, name: 'Severidad alta', min: 660, max: Infinity, color: [110, 22, 140] },
];

export const LANDCOVER = {
  10: { name: 'Bosque', color: '#006400', habitat: true },
  20: { name: 'Matorral', color: '#ffbb22', habitat: true },
  30: { name: 'Pajonal / pastizal', color: '#ffff4c', habitat: true },
  40: { name: 'Cultivos', color: '#f096ff' },
  50: { name: 'Zona urbana / construida', color: '#fa0000' },
  60: { name: 'Suelo desnudo / roca', color: '#b4b4b4' },
  70: { name: 'Nieve / hielo', color: '#f0f0f0' },
  80: { name: 'Agua', color: '#0064c8' },
  90: { name: 'Humedal / bofedal', color: '#0096a0', habitat: true },
  95: { name: 'Manglar', color: '#00cf75', habitat: true },
  100: { name: 'Musgo / liquen', color: '#fae6a0', habitat: true },
};

// SCL de Sentinel-2: 2 sombra oscura, 4 vegetación, 5 suelo, 6 agua, 7 sin clasificar, 11 nieve.
// Las cicatrices de quemado a veces se etiquetan como sombra (3): solo se aceptan en una 2.ª pasada.
const SCL_STRICT = new Set([2, 4, 5, 6, 7, 11]);
const SCL_LENIENT = new Set([2, 3, 4, 5, 6, 7, 11]);

let pool = null;
try { pool = new GeoTIFF.Pool(); } catch { pool = null; }
const tiffCache = new Map();
function openTiff(url) {
  if (!tiffCache.has(url)) tiffCache.set(url, GeoTIFF.fromUrl(url, { allowFullFile: false }).catch((e) => { tiffCache.delete(url); throw e; }));
  return tiffCache.get(url);
}

// ---------- Escenas ----------
export async function searchScenes(bbox, start, end, maxCloud) {
  const body = {
    collections: ['sentinel-2-l2a'], bbox, limit: 100,
    datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
  };
  const r = await fetch(STAC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Búsqueda STAC falló (HTTP ${r.status})`);
  const j = await r.json();
  return j.features.map((f) => ({
    id: f.id,
    date: f.properties.datetime.slice(0, 10),
    cloud: f.properties['eo:cloud_cover'],
    epsg: f.properties['proj:epsg'] ?? +String(f.properties['proj:code'] || '').split(':')[1],
    offset: f.properties['earthsearch:boa_offset_applied'] === false && parseFloat(f.properties['s2:processing_baseline']) >= 4 ? -0.1 : 0,
    href: { red: f.assets.red.href, nir: f.assets.nir.href, swir: f.assets.swir22.href, scl: f.assets.scl.href, visual: f.assets.visual.href },
  }));
}

// Agrupa por fecha y elige las fechas más cercanas al incendio (todas las teselas de cada fecha)
export function pickScenes(scenes, maxDates, newestFirst = true, recencyWeight = 6) {
  const byDate = new Map();
  for (const s of scenes) (byDate.get(s.date) || byDate.set(s.date, []).get(s.date)).push(s);
  const dates = [...byDate.keys()].sort();
  if (newestFirst) dates.reverse();
  // Prioriza fechas poco nubosas sin perder cercanía temporal
  const ranked = dates.map((d, i) => ({ d, score: i * recencyWeight + Math.min(...byDate.get(d).map((s) => s.cloud)) }))
    .sort((a, b) => a.score - b.score).slice(0, maxDates);
  return ranked.flatMap(({ d }) => byDate.get(d).sort((a, b) => a.cloud - b.cloud));
}

// ---------- Grilla de salida (lat/lon) ----------
export function makeGrid(bbox, targetRes = 20, maxDim = 1400) {
  const [w, s, e, n] = bbox;
  const latc = (s + n) / 2;
  const mx = 111320 * Math.cos((latc * Math.PI) / 180), my = 110574;
  const widthM = (e - w) * mx, heightM = (n - s) * my;
  const res = Math.max(targetRes, Math.max(widthM, heightM) / maxDim);
  const nx = Math.max(1, Math.round(widthM / res)), ny = Math.max(1, Math.round(heightM / res));
  const dlon = (e - w) / nx, dlat = (n - s) / ny;
  return { bbox, nx, ny, n: nx * ny, dlon, dlat, res, pixelHa: (dlon * mx * dlat * my) / 1e4 };
}

function utmDef(epsg) {
  const south = epsg >= 32700;
  return `+proj=utm +zone=${epsg - (south ? 32700 : 32600)} ${south ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
}

const coordCache = new Map();
function gridCoords(grid, epsg) {
  const key = `${grid.bbox.join(',')}|${grid.nx}|${epsg}`;
  if (coordCache.has(key)) return coordCache.get(key);
  const tr = proj4('EPSG:4326', utmDef(epsg));
  const xs = new Float64Array(grid.n), ys = new Float64Array(grid.n);
  const [w, , , n] = grid.bbox;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let r = 0, i = 0; r < grid.ny; r++) {
    const lat = n - (r + 0.5) * grid.dlat;
    for (let c = 0; c < grid.nx; c++, i++) {
      const p = tr.forward([w + (c + 0.5) * grid.dlon, lat]);
      xs[i] = p[0]; ys[i] = p[1];
      if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
      if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
    }
  }
  const out = { xs, ys, ext: [minx - 40, miny - 40, maxx + 40, maxy + 40] };
  coordCache.set(key, out);
  return out;
}

// Lee una ventana de un COG y devuelve el índice de muestreo para cada píxel de la grilla
async function readWindow(url, ext, res, samples) {
  const tiff = await openTiff(url);
  const img = await tiff.getImage();
  const ib = img.getBoundingBox();
  const bb = [Math.max(ext[0], ib[0]), Math.max(ext[1], ib[1]), Math.min(ext[2], ib[2]), Math.min(ext[3], ib[3])];
  if (bb[0] >= bb[2] || bb[1] >= bb[3]) return null;
  const width = Math.max(1, Math.round((bb[2] - bb[0]) / res));
  const height = Math.max(1, Math.round((bb[3] - bb[1]) / res));
  const data = await tiff.readRasters({ bbox: bb, width, height, samples, resampleMethod: 'nearest', fillValue: 0, pool });
  return { bb, width, height, data };
}

function sampleIndex(win, xs, ys) {
  const idx = new Int32Array(xs.length);
  const [x0, y0, x1, y1] = win.bb;
  const sx = win.width / (x1 - x0), sy = win.height / (y1 - y0);
  for (let i = 0; i < xs.length; i++) {
    const c = Math.floor((xs[i] - x0) * sx), r = Math.floor((y1 - ys[i]) * sy);
    idx[i] = c < 0 || r < 0 || c >= win.width || r >= win.height ? -1 : r * win.width + c;
  }
  return idx;
}

async function loadScene(scene, grid) {
  const { xs, ys, ext } = gridCoords(grid, scene.epsg);
  const res = Math.min(grid.res, 20);
  const [scl, red, nir, swir, vis] = await Promise.all([
    readWindow(scene.href.scl, ext, res, [0]),
    readWindow(scene.href.red, ext, res, [0]),
    readWindow(scene.href.nir, ext, res, [0]),
    readWindow(scene.href.swir, ext, res, [0]),
    readWindow(scene.href.visual, ext, res, [0, 1, 2]).catch(() => null),
  ]);
  if (!scl || !red || !nir || !swir) return null;
  return { scene, idx: sampleIndex(scl, xs, ys), scl: scl.data[0], red: red.data[0], nir: nir.data[0], swir: swir.data[0], vis: vis ? vis.data : null };
}

// Mosaico píxel a píxel: primera escena con dato válido (según SCL) en orden de prioridad
function composite(loaded, grid) {
  const N = grid.n;
  const red = new Float32Array(N).fill(NaN), nir = new Float32Array(N).fill(NaN), swir = new Float32Array(N).fill(NaN);
  const rgb = new Uint8ClampedArray(N * 4);
  const water = new Uint8Array(N), snow = new Uint8Array(N), src = new Int8Array(N).fill(-1);
  let strictFilled = 0;
  for (const valid of [SCL_STRICT, SCL_LENIENT]) {
    if (valid === SCL_LENIENT) for (let i = 0; i < N; i++) if (src[i] >= 0) strictFilled++;
    loaded.forEach((L, k) => {
      const s = 1e-4, o = L.scene.offset;
      for (let i = 0; i < N; i++) {
        if (src[i] >= 0) continue;
        const j = L.idx[i];
        if (j < 0) continue;
        const c = L.scl[j];
        if (!valid.has(c)) continue;
        const a = L.red[j], b = L.nir[j], d = L.swir[j];
        if (!a || !b || !d) continue;
        red[i] = a * s + o; nir[i] = b * s + o; swir[i] = d * s + o;
        if (c === 6) water[i] = 1; if (c === 11) snow[i] = 1;
        if (L.vis) { rgb[i * 4] = L.vis[0][j]; rgb[i * 4 + 1] = L.vis[1][j]; rgb[i * 4 + 2] = L.vis[2][j]; rgb[i * 4 + 3] = 255; }
        src[i] = k;
      }
    });
  }
  const nbr = new Float32Array(N), ndvi = new Float32Array(N);
  let valid = 0;
  for (let i = 0; i < N; i++) {
    if (src[i] < 0) { nbr[i] = NaN; ndvi[i] = NaN; continue; }
    nbr[i] = (nir[i] - swir[i]) / (nir[i] + swir[i]);
    ndvi[i] = (nir[i] - red[i]) / (nir[i] + red[i]);
    valid++;
  }
  return { nbr, ndvi, rgb, water, snow, src, coverage: valid / N, strictCoverage: strictFilled / N, scenesUsed: loaded.map((L, k) => ({ ...L.scene, pixels: countEq(src, k) })) };
}

function countEq(a, v) { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] === v) c++; return c; }

async function buildPeriod(scenes, grid, label, log) {
  const loaded = [];
  for (const [k, sc] of scenes.entries()) {
    log(`${label}: leyendo ${sc.id} (${sc.date}, nubes ${sc.cloud.toFixed(0)}%) [${k + 1}/${scenes.length}]`);
    try {
      const L = await loadScene(sc, grid);
      if (L) loaded.push(L);
      // Si el mosaico ya cubre casi todo el área sin nubes, no hace falta leer más escenas
      if (L && k < scenes.length - 1 && composite(loaded, grid).strictCoverage > 0.995) {
        log(`${label}: mosaico completo, se omiten ${scenes.length - k - 1} escenas restantes`);
        break;
      }
    } catch (e) {
      log(`  ⚠ no se pudo leer ${sc.id}: ${e.message || e}`);
    }
  }
  if (!loaded.length) throw new Error(`No hay escenas utilizables para el periodo "${label}"`);
  return composite(loaded, grid);
}

// ---------- ESA WorldCover 2021 (10 m) ----------
function wcTileName(lat, lon) {
  const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3;
  const ns = (la < 0 ? 'S' : 'N') + String(Math.abs(la)).padStart(2, '0');
  const ew = (lo < 0 ? 'W' : 'E') + String(Math.abs(lo)).padStart(3, '0');
  return { name: `ESA_WorldCover_10m_2021_v200_${ns}${ew}_Map.tif`, la, lo };
}

async function loadLandcover(grid, log) {
  const [w, s, e, n] = grid.bbox;
  const tiles = new Map();
  for (const lat of [s, n]) for (const lon of [w, e]) { const t = wcTileName(lat, lon); tiles.set(t.name, t); }
  const lc = new Uint8Array(grid.n);
  for (const t of tiles.values()) {
    log(`Cobertura del suelo: leyendo ${t.name}`);
    try {
      const ext = [Math.max(w, t.lo), Math.max(s, t.la), Math.min(e, t.lo + 3), Math.min(n, t.la + 3)];
      if (ext[0] >= ext[2] || ext[1] >= ext[3]) continue;
      const tiff = await openTiff(`/proxy/worldcover/${t.name}`);
      const width = Math.max(1, Math.round((ext[2] - ext[0]) / grid.dlon));
      const height = Math.max(1, Math.round((ext[3] - ext[1]) / grid.dlat));
      const data = (await tiff.readRasters({ bbox: ext, width, height, resampleMethod: 'nearest', fillValue: 0, pool }))[0];
      for (let r = 0, i = 0; r < grid.ny; r++) {
        const lat = n - (r + 0.5) * grid.dlat;
        const rr = Math.floor(((ext[3] - lat) / (ext[3] - ext[1])) * height);
        for (let c = 0; c < grid.nx; c++, i++) {
          const lon = w + (c + 0.5) * grid.dlon;
          const cc = Math.floor(((lon - ext[0]) / (ext[2] - ext[0])) * width);
          if (rr >= 0 && rr < height && cc >= 0 && cc < width) lc[i] = data[rr * width + cc];
        }
      }
    } catch (err) {
      log(`  ⚠ cobertura no disponible (${err.message || err}); se omite el cruce por tipo de vegetación`);
      return null;
    }
  }
  return lc;
}

// ---------- Análisis principal ----------
export async function runAnalysis({ bbox, pre, post, maxCloud, maxDates = 3 }, log = () => {}) {
  const grid = makeGrid(bbox);
  log(`Grilla de ${grid.nx}×${grid.ny} píxeles a ~${grid.res.toFixed(0)} m`);

  log('Buscando imágenes Sentinel-2 L2A…');
  const [preAll, postAll] = await Promise.all([
    searchScenes(bbox, pre[0], pre[1], maxCloud),
    searchScenes(bbox, post[0], post[1], maxCloud),
  ]);
  if (!preAll.length) throw new Error('No se encontraron imágenes "antes" con esa nubosidad. Amplía el rango de fechas o la nubosidad máxima.');
  if (!postAll.length) throw new Error('No se encontraron imágenes "después" con esa nubosidad. Amplía el rango de fechas o la nubosidad máxima.');
  const preScenes = pickScenes(preAll, maxDates, true);
  // Después: prima la fecha más reciente para captar toda la extensión del fuego
  const postScenes = pickScenes(postAll, maxDates, true, 15);
  log(`Antes: ${preAll.length} escenas, se usan ${preScenes.length} · Después: ${postAll.length}, se usan ${postScenes.length}`);

  const before = await buildPeriod(preScenes, grid, 'Antes', log);
  const after = await buildPeriod(postScenes, grid, 'Después', log);
  const landcover = await loadLandcover(grid, log);

  log('Calculando dNBR y severidad…');
  const N = grid.n;
  const dnbr = new Float32Array(N).fill(NaN);
  const vals = [];
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(before.nbr[i]) || Number.isNaN(after.nbr[i])) continue;
    dnbr[i] = (before.nbr[i] - after.nbr[i]) * 1000;
    if (i % 7 === 0) vals.push(dnbr[i]);
  }
  // Corrección de offset: la mediana del área (mayormente no quemada) debería ser ~0
  vals.sort((a, b) => a - b);
  const offset = vals.length ? vals[Math.floor(vals.length / 2)] : 0;

  const sev = new Uint8Array(N);
  const valid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(dnbr[i])) continue;
    valid[i] = 1;
    dnbr[i] -= offset;
    if (before.water[i] || after.water[i] || before.snow[i] || after.snow[i]) continue;
    if (before.ndvi[i] < 0.1) continue; // sin vegetación previa: no puede haberse quemado vegetación
    const d = dnbr[i];
    sev[i] = d >= 660 ? 4 : d >= 440 ? 3 : d >= 270 ? 2 : d >= 100 ? 1 : 0;
  }
  // Limpieza de ruido: un píxel quemado aislado (<2 vecinos quemados) se descarta
  const clean = new Uint8Array(sev);
  for (let r = 0; r < grid.ny; r++) for (let c = 0; c < grid.nx; c++) {
    const i = r * grid.nx + c;
    if (!sev[i]) continue;
    let nb = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < grid.ny && cc < grid.nx && sev[rr * grid.nx + cc]) nb++;
    }
    if (nb < 2) clean[i] = 0;
  }

  // Estadísticas
  const ha = grid.pixelHa;
  const bySev = [0, 0, 0, 0, 0];
  const byLc = {};
  let burnedPix = 0, sumD = 0, sumPreNdvi = 0, sumPostNdvi = 0, urbanNear = 0;
  let bminR = Infinity, bmaxR = -1, bminC = Infinity, bmaxC = -1;
  for (let r = 0, i = 0; r < grid.ny; r++) for (let c = 0; c < grid.nx; c++, i++) {
    if (!valid[i]) continue;
    const s = clean[i];
    bySev[s]++;
    if (!s) continue;
    burnedPix++; sumD += dnbr[i]; sumPreNdvi += before.ndvi[i]; sumPostNdvi += after.ndvi[i];
    if (r < bminR) bminR = r; if (r > bmaxR) bmaxR = r; if (c < bminC) bminC = c; if (c > bmaxC) bmaxC = c;
    if (landcover) {
      const k = landcover[i] || 0;
      const o = (byLc[k] ||= { ha: 0, sev: [0, 0, 0, 0, 0] });
      o.ha += ha; o.sev[s] += ha;
    }
  }
  // Zona urbana a <=100 m de área quemada (riesgo para viviendas)
  if (landcover) {
    const rad = Math.max(1, Math.round(100 / grid.res));
    for (let r = 0; r < grid.ny; r++) for (let c = 0; c < grid.nx; c++) {
      const i = r * grid.nx + c;
      if (landcover[i] !== 50) continue;
      let hit = false;
      for (let dr = -rad; dr <= rad && !hit; dr++) for (let dc = -rad; dc <= rad && !hit; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < grid.ny && cc < grid.nx && clean[rr * grid.nx + cc]) hit = true;
      }
      if (hit) urbanNear++;
    }
  }

  const [w, , , n] = bbox;
  const burnedBbox = burnedPix
    ? [w + bminC * grid.dlon, n - (bmaxR + 1) * grid.dlat, w + (bmaxC + 1) * grid.dlon, n - bminR * grid.dlat]
    : null;

  log('Listo.');
  return {
    grid, bbox, offset,
    before, after, dnbr, severity: clean, valid, landcover,
    stats: {
      validPct: (valid.reduce((a, b) => a + b, 0) / N) * 100,
      bySevHa: bySev.map((p) => p * ha),
      burnedHa: burnedPix * ha,
      aoiHa: N * ha,
      meanDnbr: burnedPix ? sumD / burnedPix : 0,
      preNdvi: burnedPix ? sumPreNdvi / burnedPix : 0,
      postNdvi: burnedPix ? sumPostNdvi / burnedPix : 0,
      byLandcover: byLc,
      urbanNearHa: urbanNear * ha,
      burnedBbox,
    },
    scenes: { before: before.scenesUsed, after: after.scenesUsed },
  };
}

// ---------- Rasters para el mapa ----------
export function severityImage(result) {
  const { grid, severity } = result;
  const img = new ImageData(grid.nx, grid.ny);
  for (let i = 0; i < grid.n; i++) {
    const c = SEVERITY[severity[i]].color;
    if (!c) continue;
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 235;
  }
  return toDataURL(img);
}

export function rgbImage(result, which) {
  const { grid } = result;
  return toDataURL(new ImageData(new Uint8ClampedArray(result[which].rgb), grid.nx, grid.ny));
}

export function landcoverImage(result) {
  const { grid, landcover } = result;
  if (!landcover) return null;
  const img = new ImageData(grid.nx, grid.ny);
  for (let i = 0; i < grid.n; i++) {
    const lc = LANDCOVER[landcover[i]];
    if (!lc) continue;
    const h = lc.color;
    img.data[i * 4] = parseInt(h.slice(1, 3), 16); img.data[i * 4 + 1] = parseInt(h.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(h.slice(5, 7), 16); img.data[i * 4 + 3] = 200;
  }
  return toDataURL(img);
}

function toDataURL(img) {
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}
