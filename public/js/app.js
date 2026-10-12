/* global L */
import { runAnalysis, severityImage, rgbImage, landcoverImage, SEVERITY, LANDCOVER } from './analysis.js';
import { biodiversity } from './fauna.js';
import { loadDistricts, compare, boundsOverLima, limaMarker } from './lima.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => x.toLocaleString('es-PE', { maximumFractionDigits: d, minimumFractionDigits: d });
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const MAX_SIDE_KM = 60;

// ---------- Mapa ----------
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([-13.45, -72.1], 9);
const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18, attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
}).addTo(map);
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' });
L.control.layers({ 'Satélite (Esri)': esri, 'Topográfico': topo }, null, { position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

for (const [name, z] of [['cmpBefore', 410], ['cmpAfter', 420], ['analysis', 430], ['aoi', 440]]) map.createPane(name).style.zIndex = z;
const afterPane = map.getPane('cmpAfter');

// ---------- Lima como referencia de escala ----------
limaMarker().addTo(map);
const limaLayer = L.layerGroup().addTo(map);
loadDistricts().then((fc) => {
  L.geoJSON(fc, {
    style: { color: '#ffffff', weight: 1, opacity: 0.7, fill: false },
    onEachFeature: (f, l) => l.bindTooltip(`<b>${f.properties.nombre}</b><br>${fmt(f.properties.ha)} ha${f.properties.poblacion ? ` · ${fmt(f.properties.poblacion)} hab.` : ''}`),
  }).addTo(limaLayer);
}).catch(() => {});

const state = { aoi: null, aoiLayer: null, result: null, overlays: {}, firms: null, firmsLayer: L.layerGroup().addTo(map), view: 'severity' };

// ---------- Fechas por defecto ----------
const today = new Date();
$('post-end').value = iso(today);
$('post-start').value = iso(addDays(today, -12));
$('pre-end').value = iso(addDays(today, -20));
$('pre-start').value = iso(addDays(today, -75));
$('cloud').oninput = () => { $('cloud-out').textContent = `${$('cloud').value}%`; };

// ---------- Focos FIRMS y agrupamiento ----------
function clusterPoints(points, cell = 0.02) {
  const cells = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.lat / cell)},${Math.floor(p.lon / cell)}`;
    (cells.get(k) || cells.set(k, []).get(k)).push(p);
  }
  const seen = new Set(), clusters = [];
  for (const k of cells.keys()) {
    if (seen.has(k)) continue;
    const stack = [k], pts = [];
    seen.add(k);
    while (stack.length) {
      const cur = stack.pop();
      pts.push(...cells.get(cur));
      const [r, c] = cur.split(',').map(Number);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nk = `${r + dr},${c + dc}`;
        if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon), dates = pts.map((p) => p.date).sort();
    clusters.push({
      pts, count: pts.length, frp: pts.reduce((a, p) => a + p.frp, 0),
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      first: dates[0], last: dates[dates.length - 1],
      center: [lats.reduce((a, b) => a + b) / lats.length, lons.reduce((a, b) => a + b) / lons.length],
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

function ageColor(date) {
  const days = (today - new Date(`${date}T12:00:00Z`)) / 864e5;
  return days < 1.5 ? '#ff1f1f' : days < 3 ? '#ff7a00' : '#ffc400';
}

async function loadFirms() {
  try {
    const r = await fetch('/api/firms');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.firms = j;
    for (const p of j.points) {
      L.circleMarker([p.lat, p.lon], { radius: 3.5, color: '#000', weight: 0.5, fillColor: ageColor(p.date), fillOpacity: 0.95 })
        .bindTooltip(`${p.date} ${p.time.padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')} UTC · ${p.src}<br>FRP ${p.frp} MW · confianza ${p.conf}`)
        .addTo(state.firmsLayer);
    }
    const clusters = clusterPoints(j.points).filter((c) => c.count >= 3).slice(0, 15);
    $('firms-status').textContent = `${fmt(j.count)} detecciones en la región. Grupos principales (clic para analizar):`;
    const ol = $('clusters');
    ol.innerHTML = '';
    clusters.forEach((c, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<b>Foco ${i + 1} · <span class="place">${c.center[0].toFixed(3)}, ${c.center[1].toFixed(3)}</span></b>
        <span class="muted small">${c.count} detecciones · ${c.first === c.last ? c.first : `${c.first} → ${c.last}`} · ${fmt(c.frp)} MW</span>`;
      li.onclick = () => {
        document.querySelectorAll('#clusters li').forEach((x) => x.classList.remove('sel'));
        li.classList.add('sel');
        const pad = 0.03;
        setAoi([c.bbox[0] - pad, c.bbox[1] - pad, c.bbox[2] + pad, c.bbox[3] + pad], `Foco ${i + 1}`);
        const preEnd = addDays(new Date(`${c.first}T12:00:00Z`), -2);
        if (preEnd < new Date($('pre-end').value)) { $('pre-end').value = iso(preEnd); $('pre-start').value = iso(addDays(preEnd, -55)); }
      };
      ol.appendChild(li);
      c.li = li;
    });
    labelClusters(clusters);
  } catch (e) {
    $('firms-status').textContent = `No se pudieron cargar los focos FIRMS (${e.message}). Puedes dibujar el área manualmente.`;
  }
}

// Nombres de lugar (OpenStreetMap Nominatim, 1 consulta/segundo)
async function labelClusters(clusters) {
  for (const c of clusters) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=es&lat=${c.center[0]}&lon=${c.center[1]}`);
      const a = (await r.json()).address || {};
      const place = [a.village || a.town || a.city || a.municipality || a.suburb, a.county || a.state_district, a.state].filter(Boolean).join(', ');
      if (place) c.li.querySelector('.place').textContent = place;
      // Prioriza los focos del departamento de Cusco
      if (a.state && !/cusco/i.test(a.state)) { c.li.classList.add('other'); c.li.parentNode.appendChild(c.li); }
    } catch { /* sin nombre */ }
    await new Promise((res) => setTimeout(res, 1100));
  }
}

// ---------- Área de análisis ----------
function sideKm(b) {
  const lat = (b[1] + b[3]) / 2;
  return [(b[2] - b[0]) * 111.32 * Math.cos((lat * Math.PI) / 180), (b[3] - b[1]) * 110.57];
}

function setAoi(bbox, label = 'Área seleccionada') {
  const [wkm, hkm] = sideKm(bbox);
  if (state.aoiLayer) map.removeLayer(state.aoiLayer);
  state.aoiLayer = L.rectangle([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { pane: 'aoi', color: '#00e5ff', weight: 2, fill: false, dashArray: '6 4' }).addTo(map);
  map.fitBounds(state.aoiLayer.getBounds(), { padding: [30, 30] });
  const ok = wkm <= MAX_SIDE_KM && hkm <= MAX_SIDE_KM;
  state.aoi = ok ? bbox : null;
  $('btn-run').disabled = !ok;
  $('aoi-info').innerHTML = ok
    ? `<b>${label}</b>: ${fmt(wkm, 1)} × ${fmt(hkm, 1)} km (${fmt(wkm * hkm * 100)} ha)`
    : `<b>Área demasiado grande</b> (${fmt(wkm, 1)} × ${fmt(hkm, 1)} km). Máximo ${MAX_SIDE_KM} km por lado.`;
}

$('btn-view').onclick = () => {
  const b = map.getBounds();
  setAoi([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], 'Vista actual');
};

$('btn-draw').onclick = () => {
  const btn = $('btn-draw');
  btn.classList.add('active');
  document.body.classList.add('drawing');
  map.dragging.disable();
  let start = null, rect = null;
  const down = (e) => { start = e.latlng; rect = L.rectangle([start, start], { pane: 'aoi', color: '#00e5ff', weight: 2, fill: false }).addTo(map); };
  const move = (e) => { if (rect) rect.setBounds([start, e.latlng]); };
  const up = (e) => {
    map.off('mousedown', down).off('mousemove', move).off('mouseup', up);
    map.dragging.enable();
    btn.classList.remove('active');
    document.body.classList.remove('drawing');
    if (!rect) return;
    const b = L.latLngBounds(start, e.latlng);
    map.removeLayer(rect);
    if (b.getNorth() - b.getSouth() < 0.005) return;
    setAoi([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], 'Área dibujada');
  };
  map.on('mousedown', down).on('mousemove', move).on('mouseup', up);
};

// ---------- Ejecución ----------
function log(msg) {
  const el = $('log');
  el.hidden = false;
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

$('btn-run').onclick = async () => {
  if (!state.aoi) return;
  const btn = $('btn-run');
  btn.disabled = true;
  btn.textContent = 'Analizando…';
  $('log').textContent = '';
  try {
    const result = await runAnalysis({
      bbox: state.aoi,
      pre: [$('pre-start').value, $('pre-end').value],
      post: [$('post-start').value, $('post-end').value],
      maxCloud: +$('cloud').value,
    }, log);
    state.result = result;
    renderResult(result);
  } catch (e) {
    console.error(e);
    log(`❌ ${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analizar daño';
  }
};

// ---------- Capas y comparador ----------
function clearOverlays() {
  for (const l of Object.values(state.overlays)) if (l) map.removeLayer(l);
  state.overlays = {};
}

function gibsLayer(date, pane) {
  return L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_Bands721/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
    pane, maxNativeZoom: 9, maxZoom: 18, attribution: 'NASA GIBS / MODIS Terra 7-2-1',
  });
}

function setView(view) {
  state.view = view;
  clearOverlays();
  const r = state.result;
  const bounds = r ? [[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]] : null;
  const swipe = view === 's2' || view === 'gibs';
  $('swipe').hidden = !swipe;
  $('swipe-labels').hidden = !swipe;
  afterPane.style.clip = '';
  if (view === 'severity' && r) {
    state.overlays.sev = L.imageOverlay(r.images.severity, bounds, { pane: 'analysis', opacity: 0.9, interactive: false }).addTo(map);
  } else if (view === 's2' && r) {
    state.overlays.b = L.imageOverlay(r.images.before, bounds, { pane: 'cmpBefore' }).addTo(map);
    state.overlays.a = L.imageOverlay(r.images.after, bounds, { pane: 'cmpAfter' }).addTo(map);
    $('lbl-before').textContent = r.scenes.before.filter((s) => s.pixels).map((s) => s.date).filter(uniq).join(', ');
    $('lbl-after').textContent = r.scenes.after.filter((s) => s.pixels).map((s) => s.date).filter(uniq).join(', ');
  } else if (view === 'gibs') {
    const d1 = $('pre-end').value;
    const d2 = iso(addDays(new Date(`${$('post-end').value}T12:00:00Z`), $('post-end').value >= iso(today) ? -1 : 0));
    state.overlays.b = gibsLayer(d1, 'cmpBefore').addTo(map);
    state.overlays.a = gibsLayer(d2, 'cmpAfter').addTo(map);
    $('lbl-before').textContent = d1;
    $('lbl-after').textContent = d2;
  } else if (view === 'landcover' && r && r.images.landcover) {
    state.overlays.lc = L.imageOverlay(r.images.landcover, bounds, { pane: 'analysis', opacity: 0.75 }).addTo(map);
  }
  if (swipe) updateClip();
  renderLegend();
}
const uniq = (v, i, a) => a.indexOf(v) === i;

function updateClip() {
  if ($('swipe').hidden) return;
  const ratio = $('swipe-range').value / 100;
  const size = map.getSize();
  const nw = map.containerPointToLayerPoint([0, 0]);
  const se = map.containerPointToLayerPoint(size);
  afterPane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${nw.x + size.x * ratio}px)`;
  $('swipe-line').style.left = `${ratio * 100}%`;
}
$('swipe-range').oninput = updateClip;
map.on('move zoom resize', updateClip);

document.querySelectorAll('input[name=view]').forEach((el) => { el.onchange = () => setView(el.value); });
$('chk-firms').onchange = (e) => (e.target.checked ? state.firmsLayer.addTo(map) : map.removeLayer(state.firmsLayer));

function renderLegend() {
  const el = $('legend');
  const sw = (c, t) => `<div><i style="background:${c}"></i>${t}</div>`;
  let html = '';
  if (state.view === 'severity') html = SEVERITY.filter((s) => s.color).map((s) => sw(`rgb(${s.color})`, s.name)).join('');
  if (state.view === 'landcover') html = Object.values(LANDCOVER).map((l) => sw(l.color, l.name)).join('');
  if (state.view === 'gibs') html = '<div class="small">Bandas 7-2-1: cicatrices de quemado en marrón rojizo, vegetación en verde.</div>';
  if (state.view === 's2') html = '<div class="small">Arrastra el control inferior para comparar.</div>';
  if ($('chk-firms').checked) html += sw('#ff1f1f', 'Foco &lt;36 h') + sw('#ff7a00', 'Foco 1-3 días') + sw('#ffc400', 'Foco 3-7 días');
  el.innerHTML = html;
}

// ---------- Resultados ----------
function bars(el, rows, total) {
  el.innerHTML = rows.map((r) => `<div class="bar"><span>${r.name}</span>
    <div class="track"><div class="fill" style="width:${total ? (100 * r.value) / total : 0}%;background:${r.color}"></div></div>
    <span class="val">${fmt(r.value)} ha</span></div>`).join('') || '<p class="muted">Sin datos.</p>';
}

function renderResult(r) {
  r.images = { severity: severityImage(r), before: rgbImage(r, 'before'), after: rgbImage(r, 'after'), landcover: landcoverImage(r) };
  const s = r.stats;
  $('results').hidden = false;
  $('k-burned').textContent = fmt(s.burnedHa);
  $('k-high').textContent = fmt(s.bySevHa[3] + s.bySevHa[4]);
  $('k-ndvi').textContent = s.burnedHa ? `${fmt(100 * (1 - s.postNdvi / s.preNdvi))}%` : '–';
  $('k-urban').textContent = r.landcover ? fmt(s.urbanNearHa, 1) : '–';
  $('coverage').textContent = `Píxeles con dato válido (sin nubes) en ambas fechas: ${fmt(s.validPct)}% del área. ` +
    `Resolución ~${fmt(r.grid.res)} m. Corrección de offset dNBR: ${fmt(r.offset)}.` +
    (s.validPct < 70 ? ' ⚠ Mucha nubosidad: el área quemada real puede ser mayor.' : '');

  const sevRows = SEVERITY.slice(1).map((c) => ({ name: c.name, value: s.bySevHa[c.id], color: `rgb(${c.color})` }));
  bars($('sev-bars'), sevRows, Math.max(...sevRows.map((x) => x.value)));

  const lcRows = Object.entries(s.byLandcover).map(([k, v]) => ({ name: LANDCOVER[k]?.name || 'Sin clasificar', value: v.ha, color: LANDCOVER[k]?.color || '#999' }))
    .sort((a, b) => b.value - a.value);
  if (r.landcover) bars($('lc-bars'), lcRows, Math.max(0, ...lcRows.map((x) => x.value)));
  else $('lc-bars').innerHTML = '<p class="muted">Cobertura del suelo no disponible.</p>';

  const sceneList = (arr) => arr.filter((x) => x.pixels > 0).map((x) => `${x.id} (${x.cloud.toFixed(0)}% nubes, ${fmt((100 * x.pixels) / r.grid.n)}% del mosaico)`).join('<br>');
  $('scenes').innerHTML = `<b>Antes:</b><br>${sceneList(r.scenes.before)}<br><b>Después:</b><br>${sceneList(r.scenes.after)}`;

  document.querySelector('input[name=view][value=severity]').checked = true;
  setView('severity');
  renderLima(r);
  renderFauna(r);
}

async function renderLima(r) {
  const el = $('lima');
  backToFire(false);
  const burned = r.stats.burnedHa;
  if (!burned) { el.innerHTML = '<p class="muted">Sin área quemada que comparar.</p>'; $('btn-lima').hidden = true; return; }
  $('btn-lima').hidden = false;
  const c = compare(burned, await loadDistricts());
  r.lima = c;
  const mira = c.equivalences.find((e) => e.nombre === 'Miraflores');
  const times = (v) => (v >= 1 ? `${fmt(v, 1)} veces` : `el ${fmt(v * 100)}% de`);
  el.innerHTML = `
    <p class="lima-big">El área quemada (<b>${fmt(burned)} ha</b>) equivale a <b>${mira ? times(mira.veces) : ''} Miraflores</b>
    y es más grande que <b>${c.smaller} de los ${c.count} distritos</b> de Lima Metropolitana.</p>
    <p>Para cubrirla habría que juntar <b>${c.covered.length} distrito${c.covered.length > 1 ? 's' : ''}</b> de los más céntricos de Lima
    (${fmt(c.coveredHa)} ha, donde viven ~${fmt(c.coveredPop)} personas):</p>
    <div class="chips">${c.covered.map((d) => `<span>${d.nombre}</span>`).join('')}</div>
    <div class="bars">${c.equivalences.map((e) => `<div class="bar"><span>${e.nombre}</span>
      <div class="track"><div class="fill" style="width:${Math.min(100, (100 * e.ha) / burned)}%;background:#8a8f98"></div></div>
      <span class="val">${e.veces >= 1 ? `×${fmt(e.veces, 1)}` : `${fmt(e.veces * 100)}%`}</span></div>`).join('')}</div>
    <p class="small muted">La barra gris es el tamaño de cada distrito frente al área quemada; la cifra indica cuántas veces cabe en ella.
    El área quemada equivale al ${fmt(c.pctLima, 1)}% de la superficie de Lima Metropolitana (${fmt(c.totalHa)} ha). Límites: OpenStreetMap · población: INEI.</p>`;
}

// Superpone la mancha quemada sobre Lima, a la misma escala, y resalta los distritos equivalentes
function showOverLima() {
  const r = state.result;
  if (!r || !r.lima) return;
  backToFire(false);
  const covered = L.geoJSON({ type: 'FeatureCollection', features: r.lima.covered.map((d) => d.feature) }, {
    isOverlay: true, style: { color: '#f3a33a', weight: 2, fillColor: '#f3a33a', fillOpacity: 0.25 },
    onEachFeature: (f, l) => l.bindTooltip(f.properties.nombre, { permanent: true, direction: 'center', className: 'district-label' }),
  }).addTo(limaLayer);
  const b = boundsOverLima(r.bbox);
  L.imageOverlay(r.images.severity, b, { pane: 'analysis', opacity: 0.85, isOverlay: true }).addTo(limaLayer);
  L.rectangle(b, { pane: 'aoi', color: '#00e5ff', weight: 1.5, fill: false, dashArray: '6 4', isOverlay: true })
    .bindTooltip('Área analizada en Cusco, trasladada a Lima a la misma escala').addTo(limaLayer);
  map.fitBounds(L.latLngBounds(b).extend(covered.getBounds()), { padding: [30, 30], animate: false });
  $('btn-lima').textContent = '↩ Volver al incendio';
  $('btn-lima').onclick = () => backToFire(true);
}

function backToFire(fly) {
  limaLayer.eachLayer((l) => { if (l.options.isOverlay) limaLayer.removeLayer(l); });
  if (fly && state.aoiLayer) map.fitBounds(state.aoiLayer.getBounds(), { padding: [30, 30], animate: false });
  $('btn-lima').textContent = '🗺 Ver el área quemada sobre Lima';
  $('btn-lima').onclick = showOverLima;
}

async function renderFauna(r) {
  const el = $('fauna');
  if (!r.stats.burnedBbox) { el.innerHTML = '<p class="muted">No se detectó área quemada en las fechas elegidas.</p>'; return; }
  el.innerHTML = '<p class="muted">Consultando GBIF…</p>';
  try {
    let b = await biodiversity(r.stats.burnedBbox, log);
    // Zonas altoandinas poco muestreadas: se amplía la búsqueda al entorno (~10 km)
    if (b.animalSpecies < 15) { log('Pocos registros en el área quemada; ampliando a ~10 km…'); b = await biodiversity(r.stats.burnedBbox, log, 0.09); }
    r.fauna = b;
    const habitat = Object.entries(r.stats.byLandcover).filter(([k]) => LANDCOVER[k]?.habitat).reduce((a, [, v]) => a + v.ha, 0);
    el.innerHTML = `
      <p>Se quemaron <b>${fmt(habitat)} ha de hábitat natural</b> (bosque, matorral, pajonal, bofedal). ${b.radiusKm > 1 ? `En un radio de ~${fmt(b.radiusKm)} km del área quemada (la zona tiene pocos muestreos)` : 'En la zona del incendio'} hay registros de
      <b>${fmt(b.animalSpecies)} especies de animales</b> y <b>${fmt(b.plantSpecies)} de plantas</b>.</p>
      <div class="groups">${b.groups.map((g) => `<div>${g.icon}<b>${fmt(g.species)}</b>${g.name}</div>`).join('')}
        <div>🌿<b>${fmt(b.plantSpecies)}</b>Plantas</div></div>
      ${b.threatened.length ? `<p><b>${b.threatened.length} especies amenazadas o casi amenazadas (UICN)</b> registradas en el área:</p>
      <table><tr><th>Especie</th><th>Grupo</th><th>UICN</th></tr>
      ${b.threatened.map((t) => `<tr><td><i>${t.scientific}</i>${t.common ? `<br><span class="muted">${t.common}</span>` : ''}</td>
        <td>${t.group}</td><td><span class="badge ${t.iucn}" title="${t.iucnName}">${t.iucn}</span></td></tr>`).join('')}</table>`
    : '<p class="muted">No hay registros de especies amenazadas en GBIF para esta zona (puede deberse a falta de muestreo).</p>'}
      <p class="small muted">Fuente: registros de presencia en <a href="${b.gbifLink}" target="_blank" rel="noopener">GBIF</a>.
      No equivalen a animales muertos: indican especies cuyo hábitat fue alcanzado por el fuego.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="muted">No se pudo consultar GBIF (${e.message}).</p>`;
  }
}

// ---------- Exportación ----------
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = typeof content === 'string' && content.startsWith('data:') ? content : URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

$('btn-csv').onclick = () => {
  const r = state.result; if (!r) return;
  const s = r.stats;
  const rows = [['indicador', 'valor', 'unidad'],
    ['area_analizada', s.aoiHa.toFixed(1), 'ha'], ['area_quemada_total', s.burnedHa.toFixed(1), 'ha'],
    ...SEVERITY.slice(1).map((c) => [`severidad_${c.name}`, s.bySevHa[c.id].toFixed(1), 'ha']),
    ...Object.entries(s.byLandcover).map(([k, v]) => [`cobertura_${LANDCOVER[k]?.name || k}`, v.ha.toFixed(1), 'ha']),
    ['dnbr_medio_quemado', s.meanDnbr.toFixed(0), 'dNBR x1000'], ['ndvi_antes', s.preNdvi.toFixed(3), ''], ['ndvi_despues', s.postNdvi.toFixed(3), ''],
    ['urbano_a_100m', s.urbanNearHa.toFixed(2), 'ha'], ['pixeles_validos', s.validPct.toFixed(1), '%'],
    ...(r.lima ? [['equivale_a_distritos_lima', r.lima.covered.map((d) => d.nombre).join(' + '), `${r.lima.coveredHa} ha`],
      ...r.lima.equivalences.map((e) => [`veces_${e.nombre}`, e.veces.toFixed(2), 'veces el distrito']),
      ['porcentaje_lima_metropolitana', r.lima.pctLima.toFixed(2), '%']] : []),
    ['bbox', r.bbox.map((x) => x.toFixed(5)).join(' '), 'lon/lat'],
    ['escenas_antes', r.scenes.before.map((x) => x.id).join(' '), ''], ['escenas_despues', r.scenes.after.map((x) => x.id).join(' '), ''],
    ...(r.fauna ? [['especies_animales', r.fauna.animalSpecies, ''], ['especies_plantas', r.fauna.plantSpecies, ''],
      ...r.fauna.threatened.map((t) => [`amenazada_${t.iucn}`, `${t.scientific}${t.common ? ` (${t.common})` : ''}`, t.group])] : []),
  ];
  download('reporte_incendio.csv', `﻿${rows.map((r2) => r2.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')}`, 'text/csv');
};

// Polígonos de severidad por tramos de fila (sin dependencias de vectorización)
$('btn-json').onclick = () => {
  const r = state.result; if (!r) return;
  const { grid, severity } = r;
  const [w, , , n] = r.bbox;
  const polys = { 1: [], 2: [], 3: [], 4: [] };
  for (let row = 0; row < grid.ny; row++) {
    let c = 0;
    while (c < grid.nx) {
      const v = severity[row * grid.nx + c];
      let e = c + 1;
      while (e < grid.nx && severity[row * grid.nx + e] === v) e++;
      if (v) {
        const x0 = w + c * grid.dlon, x1 = w + e * grid.dlon, y0 = n - (row + 1) * grid.dlat, y1 = n - row * grid.dlat;
        polys[v].push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map((p) => p.map((x) => +x.toFixed(6)))]);
      }
      c = e;
    }
  }
  const fc = {
    type: 'FeatureCollection',
    features: Object.entries(polys).filter(([, p]) => p.length).map(([k, p]) => ({
      type: 'Feature', properties: { severidad: SEVERITY[k].name, hectareas: +r.stats.bySevHa[k].toFixed(2) },
      geometry: { type: 'MultiPolygon', coordinates: p },
    })),
  };
  download('area_quemada.geojson', JSON.stringify(fc), 'application/geo+json');
};

$('btn-png').onclick = () => { if (state.result) download('severidad.png', state.result.images.severity); };

renderLegend();
loadFirms();
