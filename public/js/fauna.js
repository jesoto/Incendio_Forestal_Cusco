// Biodiversidad potencialmente afectada: registros de especies en GBIF dentro del área quemada.
// Importante: no mide mortalidad; indica qué especies se han registrado en el hábitat que se quemó.

const GBIF = 'https://api.gbif.org/v1';

export const ANIMAL_GROUPS = [
  { key: 212, name: 'Aves', icon: '🐦' },
  { key: 359, name: 'Mamíferos', icon: '🦊' },
  { key: 131, name: 'Anfibios', icon: '🐸' },
  { key: 358, name: 'Reptiles', icon: '🦎' },
  { key: 216, name: 'Insectos', icon: '🦋' },
];

const IUCN = {
  CR: 'En peligro crítico', EN: 'En peligro', VU: 'Vulnerable', NT: 'Casi amenazada',
};

function wkt([w, s, e, n]) {
  const f = (x) => x.toFixed(5);
  return `POLYGON((${f(w)} ${f(s)},${f(e)} ${f(s)},${f(e)} ${f(n)},${f(w)} ${f(n)},${f(w)} ${f(s)}))`;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GBIF HTTP ${r.status}`);
  return r.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i]).catch(() => null); }
  }));
  return out;
}

function occUrl(geom, params) {
  const q = new URLSearchParams({ geometry: geom, hasCoordinate: 'true', hasGeospatialIssue: 'false', limit: '0' });
  for (const [k, v] of params) q.append(k, v);
  return `${GBIF}/occurrence/search?${q}`;
}

// bbox: extensión del área quemada; pad en grados (0.0045 ≈ 500 m para captar especies del borde)
export async function biodiversity(bbox, log = () => {}, pad = 0.0045) {
  const geom = wkt([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad]);
  log('Consultando registros de especies en GBIF…');

  const groups = await Promise.all(ANIMAL_GROUPS.map(async (g) => {
    const j = await getJSON(occUrl(geom, [['classKey', g.key], ['facet', 'speciesKey'], ['facetLimit', '2000']]));
    const species = j.facets?.[0]?.counts?.length || 0;
    return { ...g, records: j.count, species };
  }));

  const threatParams = [['facet', 'speciesKey'], ['facetLimit', '60'],
    ...Object.keys(IUCN).map((c) => ['iucnRedListCategory', c])];
  const [animalsT, plantsT, plantsAll] = await Promise.all([
    getJSON(occUrl(geom, [['kingdomKey', 1], ...threatParams])),
    getJSON(occUrl(geom, [['kingdomKey', 6], ...threatParams])),
    getJSON(occUrl(geom, [['kingdomKey', 6], ['facet', 'speciesKey'], ['facetLimit', '3000']])),
  ]);

  const keys = [
    ...(animalsT.facets?.[0]?.counts || []).map((c) => ({ key: c.name, records: c.count, kingdom: 'Animal' })),
    ...(plantsT.facets?.[0]?.counts || []).map((c) => ({ key: c.name, records: c.count, kingdom: 'Planta' })),
  ].slice(0, 60);
  log(`GBIF: ${keys.length} especies amenazadas o casi amenazadas registradas; obteniendo nombres…`);

  const threatened = (await mapLimit(keys, 8, async (k) => {
    const [sp, iucn, vern] = await Promise.all([
      getJSON(`${GBIF}/species/${k.key}`),
      getJSON(`${GBIF}/species/${k.key}/iucnRedListCategory`).catch(() => ({})),
      getJSON(`${GBIF}/species/${k.key}/vernacularNames?limit=100`).catch(() => ({ results: [] })),
    ]);
    const es = vern.results.find((v) => v.language === 'spa') || vern.results.find((v) => v.language === 'eng');
    return {
      ...k,
      scientific: sp.canonicalName || sp.scientificName,
      common: es ? es.vernacularName.replace(/^\s*"|"\s*$/g, '').trim() : '',
      group: sp.class || sp.phylum || '',
      iucn: iucn.code || '',
      iucnName: IUCN[iucn.code] || iucn.category || '',
    };
  })).filter((x) => x && IUCN[x.iucn]);

  const order = { CR: 0, EN: 1, VU: 2, NT: 3 };
  threatened.sort((a, b) => order[a.iucn] - order[b.iucn] || b.records - a.records);

  return {
    geometry: geom,
    radiusKm: pad * 111,
    groups,
    animalSpecies: groups.reduce((a, g) => a + g.species, 0),
    plantSpecies: plantsAll.facets?.[0]?.counts?.length || 0,
    threatened,
    gbifLink: `https://www.gbif.org/occurrence/search?geometry=${encodeURIComponent(geom)}&has_coordinate=true&has_geospatial_issue=false`,
  };
}
