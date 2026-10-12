// Servidor local sin dependencias: sirve la app y hace de proxy para fuentes sin CORS
// (NASA FIRMS y ESA WorldCover). Uso: node server.js  ->  http://localhost:8080
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');

// Región de interés para filtrar focos de calor (departamento de Cusco + margen)
const REGION = { s: -15.6, n: -11.0, w: -74.6, e: -70.2 };

const FIRMS_SOURCES = [
  ['VIIRS NOAA-20', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_7d.csv'],
  ['VIIRS NOAA-21', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_America_7d.csv'],
  ['VIIRS S-NPP', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_America_7d.csv'],
];
const FIRMS_TTL = 30 * 60 * 1000;
let firmsCache = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function parseFirms(csv, source) {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',');
  const idx = (k) => head.indexOf(k);
  const iLat = idx('latitude'), iLon = idx('longitude'), iDate = idx('acq_date'), iTime = idx('acq_time'),
    iConf = idx('confidence'), iFrp = idx('frp'), iDn = idx('daynight');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length) continue;
    const lat = +c[iLat], lon = +c[iLon];
    if (lat < REGION.s || lat > REGION.n || lon < REGION.w || lon > REGION.e) continue;
    out.push({ lat, lon, date: c[iDate], time: c[iTime], conf: c[iConf], frp: +c[iFrp], dn: c[iDn], src: source });
  }
  return out;
}

async function getFirms() {
  if (firmsCache && Date.now() - firmsCache.t < FIRMS_TTL) return firmsCache.data;
  const results = await Promise.allSettled(FIRMS_SOURCES.map(([name, url]) => download(url).then((t) => parseFirms(t, name))));
  const points = [];
  const errors = [];
  results.forEach((r, i) => (r.status === 'fulfilled' ? points.push(...r.value) : errors.push(`${FIRMS_SOURCES[i][0]}: ${r.reason.message}`)));
  if (!points.length && errors.length) throw new Error(errors.join('; '));
  const data = { updated: new Date().toISOString(), region: REGION, count: points.length, errors, points };
  firmsCache = { t: Date.now(), data };
  return data;
}

// Proxy de lectura por rangos (COG) para ESA WorldCover, que no expone CORS
function proxyWorldCover(req, res, file) {
  if (!/^ESA_WorldCover_10m_2021_v200_[NS]\d{2}[EW]\d{3}_Map\.tif$/.test(file)) {
    res.writeHead(400); return res.end('archivo no permitido');
  }
  const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/${file}`;
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const up = https.request(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (r.headers[k]) h[k] = r.headers[k];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  up.end();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname === '/api/firms') {
      const data = await getFirms();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (u.pathname.startsWith('/proxy/worldcover/')) {
      return proxyWorldCover(req, res, decodeURIComponent(u.pathname.slice('/proxy/worldcover/'.length)));
    }
    let p = path.normalize(path.join(PUBLIC, decodeURIComponent(u.pathname)));
    if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('no encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Monitor de incendios Cusco: http://localhost:${PORT}`));
