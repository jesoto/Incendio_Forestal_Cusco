// Dimensiona el área quemada con referencias de Lima: equivalencias con distritos
// y superposición de la mancha quemada sobre la capital, a la misma escala.
/* global L */

export const LIMA_CENTER = [-12.0464, -77.0428]; // Plaza Mayor de Lima
const REFERENCE = ['Miraflores', 'San Isidro', 'Barranco', 'San Borja', 'Santiago de Surco', 'La Molina', 'Cercado de Lima', 'San Juan de Lurigancho'];

let districts = null;

export async function loadDistricts() {
  if (!districts) districts = fetch('data/lima_distritos.geojson').then((r) => r.json());
  return districts;
}

function centroid(geom) {
  const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates.reduce((a, p) => (p[0].length > a.length ? p[0] : a), []);
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [y / ring.length, x / ring.length];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180));

// Distritos más cercanos al centro de Lima, sumados hasta igualar el área quemada
export function compare(burnedHa, fc) {
  const feats = fc.features.map((f) => ({ ...f.properties, center: centroid(f.geometry), feature: f }));
  const totalHa = feats.reduce((a, f) => a + f.ha, 0);
  const byName = Object.fromEntries(feats.map((f) => [f.nombre, f]));
  const equivalences = REFERENCE.filter((n) => byName[n]).map((n) => ({ nombre: n, ha: byName[n].ha, veces: burnedHa / byName[n].ha }));

  const ordered = [...feats].sort((a, b) => dist(a.center, LIMA_CENTER) - dist(b.center, LIMA_CENTER));
  const covered = [];
  let acc = 0;
  for (const f of ordered) {
    if (acc >= burnedHa) break;
    covered.push(f);
    acc += f.ha;
  }
  const smaller = feats.filter((f) => f.ha <= burnedHa).length;
  return {
    totalHa, equivalences, covered, coveredHa: acc,
    coveredPop: covered.reduce((a, f) => a + (f.poblacion || 0), 0),
    pctLima: (100 * burnedHa) / totalHa,
    smaller, count: feats.length,
  };
}

// Traslada la imagen de severidad a Lima conservando su tamaño real en km
export function boundsOverLima(bbox) {
  const [w, s, e, n] = bbox;
  const latC = (s + n) / 2;
  const k = Math.cos((latC * Math.PI) / 180) / Math.cos((LIMA_CENTER[0] * Math.PI) / 180);
  const halfLat = (n - s) / 2, halfLon = ((e - w) / 2) * k;
  return [[LIMA_CENTER[0] - halfLat, LIMA_CENTER[1] - halfLon], [LIMA_CENTER[0] + halfLat, LIMA_CENTER[1] + halfLon]];
}

export function limaMarker() {
  return L.marker(LIMA_CENTER, {
    icon: L.divIcon({ className: 'lima-marker', html: '<div>★ Lima · capital</div>', iconSize: [0, 0] }),
    zIndexOffset: 1000,
  }).bindTooltip('Lima Metropolitana: 43 distritos, ~2,720 km²');
}
