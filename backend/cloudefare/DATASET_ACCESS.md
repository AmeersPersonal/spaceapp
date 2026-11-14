# Supplementary NASA dataset access

Implemented in `events.js`, exposed by `worker.js`. These adapters supplement the existing NISAR/ASF and USGS earthquake integrations. They discover real data and return source references; they do not implement raster processing, hazard predictions, or global archive ingestion.

Subsequent production deployment on November 14, 2026 configured the FIRMS key and verified every adapter, including successful empty FIRMS tables. See [ENDPOINT_REFERENCE.md](ENDPOINT_REFERENCE.md) for current production status. The initial checks below describe the earlier local implementation stage.

## Sources and retrieval scope

| Source ID | Product | Returned information | Credentials / limitations |
| --- | --- | --- | --- |
| `firms` | VIIRS NOAA-20 NRT active fires | Coordinates, acquisition time, confidence, fire radiative power in MW, satellite, instrument, day/night | Separate `FIRMS_MAP_KEY`; at most five inclusive days per query. Detections can include non-wildfire heat sources. Invalid response text is not treated as an empty fire table. |
| `gpm` | GPM IMERG Early daily precipitation (`GPM_3IMERGDE`) | Granule metadata, dates, coverage, download references | Anonymous CMR discovery; Earthdata authentication usually required for files. These are rainfall estimates, not forecasts. |
| `smap` | Enhanced daily soil moisture (`SPL3SMP_E`) | Granule metadata and download references | Same discovery/file distinction. Measurements require HDF5 extraction and quality masking. |
| `hls` | Landsat and Sentinel-2 harmonized reflectance (`HLSL30`, `HLSS30`) | Optical scene metadata and download references | Both instruments searched together. Raster bands and cloud masks require a processor. |
| `geos` | GEOS-FP `tavg1_2d_slv_Nx` surface meteorology forecasts | NetCDF file URLs, initialization time and valid time | Public NCCS directory; limited archive retention. Files are global: the query bbox is not applied to the grids. No weather values are extracted. |
| `terrain` | NASADEM merged elevation (`NASADEM_HGT`) | Intersecting elevation granules and download references | Static terrain: dates are intentionally ignored. Does not cover every latitude. |
| `grace` | JPL GRACE/GRACE-FO CRI mascons (`TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4`) | Granule metadata and download references | Can be a global multi-month NetCDF series; spatial/temporal slicing is still required. Not a direct local groundwater measurement. |

CMR short names were checked against the live collection catalog on November 14, 2026. Catalog queries do not pin a version, so callers should inspect returned provenance before comparing files. `nextPage` is available for bounded retrieval; results are not silently described as the complete archive.

Every response supplies `kind`, `credit`, `notes` and `measurementsRetrieved`. The latter is true only for retrieved FIRMS detections, not for catalog/file-reference results. `configured` in the source list reports credential presence, not whether the provider is reachable or has requested-date coverage.

## API usage

Start locally from `backend/cloudefare` with `npm run dev`.

```sh
# List adapters and credential configuration (no secrets returned).
curl 'http://localhost:8787/api/datasets'

# Discover historical precipitation files, two records per page.
curl 'http://localhost:8787/api/datasets/gpm?bbox=-119,35,-118,36&start=2025-07-01&end=2025-07-05&limit=2&page=1'

# Query multiple sources; individual errors are preserved alongside successful results.
curl 'http://localhost:8787/api/datasets/context?bbox=-119,35,-118,36&start=2025-07-01&end=2025-07-05&sources=gpm,smap,hls,terrain,grace&limit=2'

# Forecast initialization is distinct from the requested valid-time range.
curl 'http://localhost:8787/api/datasets/geos?bbox=-119,35,-118,36&start=2026-11-13&end=2026-11-14&runDate=2026-11-13&cycle=00&limit=2'

# Requires FIRMS_MAP_KEY. Use dates supported by the selected NRT product.
curl 'http://localhost:8787/api/datasets/firms?bbox=-119,35,-118,36&start=2026-11-13&end=2026-11-14&limit=10'
```

Common query parameters: `bbox` (at most 5° per side), `start`, `end` (YYYY-MM-DD, at most 366 days apart), `limit` (1–50, default 10), `page` (1–10000, default 1). Historical queries are not restricted by NISAR's launch. `sources` is a comma-separated list for the context route. GEOS adds `runDate` (defaults to start) and `cycle` (00/06/12/18, default 00). GEOS uses requested dates as forecast-valid dates. Terrain ignores dates, while GRACE matches granule temporal coverage rather than extracting individual monthly values.

The context route returns HTTP 200 for a valid request even if individual sources fail. Check each `results[source].ok`, not just HTTP status. Single-source routes return 400 for invalid inputs, 503 for missing configuration, 404 for absent archives, and 502 for upstream failures. A successful empty result means the catalog returned no matching entries; it does not establish an absence of the physical phenomenon.

## Credentials

Copy `.dev.vars.example` to `.dev.vars` and configure `FIRMS_MAP_KEY` locally for FIRMS. Obtain a free key from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/). It is separate from both the Earthdata bearer token and api.nasa.gov keys. No registration was performed and no new credential was created during this implementation.

CMR and GEOS discovery do not need the root `NASA_TOKEN`. Large Earthdata file downloads still belong in the external processor, with Earthdata Login configured there. The root token was not copied into source files or sent to the supplementary discovery endpoints. The initial implementation was checked locally; the subsequent deployment is documented in ENDPOINT_REFERENCE.md.

## Live verification

Queries were made through the local Wrangler Worker to the real NASA providers on November 14, 2026. All used bbox `[-119,35,-118,36]` and `limit=2`.

| Source | Query dates | Returned records / total matching | Result |
| --- | --- | --- | --- |
| GPM | 2025-07-01–2025-07-05 | 2 / 5 | Live catalog discovery succeeded |
| SMAP | 2025-07-01–2025-07-05 | 2 / 5 | Live catalog discovery succeeded |
| HLS | 2025-07-01–2025-07-05 | 2 / 10 | Live catalog discovery succeeded |
| NASADEM | Dates ignored | 2 / 9 | Live catalog discovery succeeded |
| GRACE/GRACE-FO | 2025-07-01–2025-07-05 | 1 / 1 | Live catalog discovery succeeded |
| GEOS-FP | Valid dates 2026-11-13–2026-11-14; initialized Nov 13 at 00 UTC | 2 / 48 | Live forecast-file discovery succeeded |
| FIRMS | 2026-11-13–2026-11-14 | Not queried upstream | Correctly reports `not_configured`; no FIRMS map key exists locally |

The November 13–14 query returned zero matching catalog records for SMAP, HLS and GRACE, while GPM returned one. This illustrates why discovery must expose coverage gaps and publication delays rather than assume every source has current data. Counts are a dated check, not a lasting availability guarantee.

No new measurement rasters were downloaded in this implementation. Automated tests mock providers; they cover successful and empty results, malformed replies, validation, pagination, CSV quoting, coordinate/date filtering, key redaction, response-size limits, provider errors and API status codes. The live checks above are separate from tests.

## Remaining work

- Implement the external processor for authenticated downloads, raster subsetting, variables/bands, quality masks and cross-source alignment.
- Persist selected supplementary records and provenance if event history is needed. These endpoints currently return results without writing D1 or R2.
- Add a FIRMS key and perform a live detection query.
- Wire verified numerical summaries into `manifest.context` for AI explanations.
- Train and evaluate hazard-specific prediction models; discovering these datasets does not establish prediction accuracy.

## Provider references

- [NASA CMR search API](https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html)
- [NASA FIRMS area API](https://firms.modaps.eosdis.nasa.gov/api/area/)
- [NASA NCCS GEOS-FP forecast archive](https://portal.nccs.nasa.gov/datashare/gmao/geos-fp/forecast/)
- [NASA HLS products](https://hls.gsfc.nasa.gov/data-products/)
- [NASA precipitation directory](https://gpm.nasa.gov/data/directory)
