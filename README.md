# Monitor de Incendios · Cusco

Aplicación web que mide el **daño real** de los incendios forestales en Cusco con imágenes satelitales. Compara la vegetación **antes y después** del fuego y estima la magnitud del impacto sobre la vegetación y la fauna.

## Qué hace

1. **Detecta los focos activos** con NASA FIRMS (VIIRS NOAA-20, NOAA-21 y S-NPP, últimos 7 días). Los agrupa en incendios y los nombra con OpenStreetMap.
2. **Mide el área quemada y su severidad** con Sentinel-2 L2A (10–20 m):
   - Arma mosaicos sin nubes del *antes* y del *después* usando la capa SCL.
   - Calcula el **NBR** (NIR B08 vs SWIR B12) y el **dNBR** = NBR antes − NBR después.
   - Clasifica la severidad con los umbrales USGS (Key & Benson): baja, moderada-baja, moderada-alta y alta.
   - Corrige el offset entre fechas y elimina píxeles aislados, agua, nieve y zonas sin vegetación previa.
3. **Cruza el resultado con la cobertura del suelo** (ESA WorldCover 2021, 10 m). Así obtiene las hectáreas quemadas de bosque, matorral, pajonal, bofedal y cultivos, y las zonas urbanas a ≤100 m del fuego.
4. **Estima la biodiversidad potencialmente afectada** con GBIF:
   - Número de especies de aves, mamíferos, anfibios, reptiles, insectos y plantas registradas en el área quemada.
   - Lista de especies amenazadas según la UICN (CR, EN, VU, NT).
5. **Visualiza los resultados** de tres formas:
   - Mapa de severidad.
   - Comparador deslizante *antes/después*, con Sentinel-2 o con MODIS diario en falso color 7-2-1.
   - Cobertura del suelo.
6. **Compara el daño con Lima.** Lima aparece marcada en el mapa con los límites de sus 43 distritos. La app expresa el área quemada en distritos de Lima ("3,7 veces Miraflores") y calcula cuántos de los distritos más céntricos harían falta para cubrirla. Con el botón *Ver el área quemada sobre Lima*, la mancha real del incendio se traslada a la capital a la misma escala. Los límites distritales vienen de OpenStreetMap y la población, del INEI; están en `public/data/lima_distritos.geojson`.
7. **Exporta** un reporte CSV, un GeoJSON de las áreas quemadas por severidad y un PNG del mapa.

## Uso

Requiere Node.js 18 o superior. No tiene dependencias que instalar.

```bash
node server.js
```

Abrir <http://localhost:8080>. Luego:

1. Elegir un foco de la lista o dibujar un rectángulo en el mapa (máximo 60 km por lado).
2. Ajustar las fechas *antes* y *después*. El "antes" debe terminar antes de que empiece el incendio.
3. Pulsar **Analizar daño**. Un área de unos 15 km tarda entre 30 y 60 s.

## Arquitectura

| Archivo | Función |
|---|---|
| `server.js` | Servidor estático. Hace de proxy para FIRMS (no tiene CORS; caché de 30 min) y para lecturas por rango de WorldCover. |
| `public/js/analysis.js` | Búsqueda STAC (Earth Search), lectura de COGs con geotiff.js, mosaico, dNBR, severidad y estadísticas. |
| `public/js/fauna.js` | Consultas a GBIF (especies por grupo y amenazadas según la UICN). |
| `public/js/app.js` | Mapa Leaflet, focos, comparador, resultados y exportación. |

Todo el procesamiento ráster ocurre en el navegador. Solo se descargan las ventanas de las bandas necesarias (Cloud-Optimized GeoTIFF).

## Limitaciones (leer antes de difundir cifras)

- **Las nubes y el humo** pueden ocultar zonas quemadas. El reporte indica el % de píxeles válidos.
- **dNBR sin validación de campo**: los cambios estacionales, como el secado del pajonal o las cosechas, pueden aparecer como severidad *baja*. Las clases *moderada* y *alta* son más confiables.
- **Fauna**: GBIF registra dónde se *observaron* especies. No mide mortalidad. En zonas altoandinas poco muestreadas hay pocos registros; en ese caso, la app amplía la búsqueda a unos 10 km y lo indica.
- **WorldCover es de 2021**, así que la cobertura puede haber cambiado desde entonces.
- Las cifras son estimaciones satelitales. No reemplazan las evaluaciones oficiales (SERFOR, INDECI, COER Cusco).
