# fixtures

## Purpose
Recorded upstream responses so tests never call ASF DAAC or USGS.

## Contents
| File | Description |
|---|---|
| `asf-search-nisar.json` | A real ASF search GeoJSON (`dataset=NISAR`), recorded 2026-11-14 and trimmed to the fields we use. It holds 2 GCOV scenes and 1 GUNW scene. The second feature's geometry was set to `coordinates: null` to match the null geometries ASF returns for some granules. |
| `usgs-earthquakes.json` | Real USGS FDSN response (M7.7 Panama and M7.0 China quakes), recorded 2026-11-14 and trimmed to the fields we use. |

## Interfaces
Imported by `../helpers.js` as `asfFixture` and `fixtureScenes()`.

## Dependencies
None.

## Tests
Used by `events.test.js`, `asf.test.js`, `api.test.js`, `ingest.test.js` and `ai.test.js`.

## Status
Done. Re-record if ASF changes NISAR metadata fields, since products are being reprocessed through 2026.

## Changelog
- 2026-11-14 - Recorded USGS earthquake fixture.
- 2026-11-14 - Recorded the initial NISAR GCOV/GUNW search fixture.
