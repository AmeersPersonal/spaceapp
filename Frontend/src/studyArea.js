// studyArea.js — everything specific to each study area lives here.
// When your real NISAR data and your model output are ready, this is the
// only file you need to edit.
//
// One entry per disaster. Each hazard is tied to the data the backend
// (backend/cloudefare/events.js) can already fetch for it, listed in
// `sources`. The images and zones are SAMPLES, made by:
//   scripts/make_sample_data.py       (volcano)
//   scripts/make_disaster_samples.py  (everything else)
//
// Fields, per area:
//   id, name, hazard   identity; `hazard` is shown in the panel header
//   isSample           true shows a "Sample data" badge
//   sources            backend datasets this hazard draws on
//   bounds             the rectangle the radar images cover, in degrees
//   dates              observed passes, oldest first (12-day NISAR cycle).
//                      `risk` (0..1) draws the solid half of the risk curve.
//   riskZonesUrl       observed zones; GeoJSON polygons with risk high|medium
//   forecast           model output past "Now": probability, level, note,
//                      optional riskZonesUrl for the predicted extent
//   legend             what dark / bright / change / zone colours mean here
//   story              paragraphs for the side panel

// Free base map, no API key.
export const basemapStyle = 'https://tiles.openfreemap.org/styles/liberty'

const OBSERVED_DATES = ['2026-09-08', '2026-09-20', '2026-10-02', '2026-10-14', '2026-10-26', '2026-11-07']
const FORECAST_DATES = ['2026-11-19', '2026-12-01', '2026-12-13', '2026-12-25']

// Builds `dates` and `forecast` for a site whose files follow the
// /data/<id>/radar_<date>.png and /data/<id>/risk_forecast_<date>.geojson layout.
function series(id, risks, forecast) {
  return {
    dates: OBSERVED_DATES.map((date, i) => ({ date, image: `/data/${id}/radar_${date}.png`, risk: risks[i] })),
    riskZonesUrl: `/data/${id}/risk_zones.geojson`,
    forecast: forecast.map(([probability, level, note], i) => ({
      date: FORECAST_DATES[i],
      probability,
      level,
      note,
      riskZonesUrl: `/data/${id}/risk_forecast_${FORECAST_DATES[i]}.geojson`,
    })),
  }
}

const PLACEHOLDER_NOTE = 'Placeholder forecast. Swap in your model output in studyArea.js.'

export const studyAreas = [
  {
    id: 'volcano',
    name: 'Mount Aso, Japan',
    hazard: 'Volcanic eruption',
    isSample: true,
    sources: ['NISAR radar (ASF)', 'NASADEM elevation'],
    // This box holds the whole Aso caldera (18 km east-west, 25 km
    // north-south) with Nakadake, the active vent, near the centre.
    bounds: { west: 130.85, south: 32.7, east: 131.35, north: 33.06 },
    dates: [
      { date: '2026-09-08', image: '/data/radar_2026-09-08.png', risk: 0.1 },
      { date: '2026-09-20', image: '/data/radar_2026-09-20.png', risk: 0.17 },
      { date: '2026-10-02', image: '/data/radar_2026-10-02.png', risk: 0.26 },
      { date: '2026-10-14', image: '/data/radar_2026-10-14.png', risk: 0.35 },
      { date: '2026-10-26', image: '/data/radar_2026-10-26.png', risk: 0.44 },
      { date: '2026-11-07', image: '/data/radar_2026-11-07.png', risk: 0.52 },
    ],
    // high = ballistics and pyroclastic flow, medium = ashfall.
    riskZonesUrl: '/data/risk_zones.geojson',
    forecast: [
      { date: '2026-11-19', probability: 0.44, level: 'medium', note: 'The caldera floor has dropped on each of the last four passes, and the rate is still increasing.', riskZonesUrl: '/data/risk_forecast_2026-11-19.geojson' },
      { date: '2026-12-01', probability: 0.62, level: 'high', note: 'Subsidence spreads beyond the central cones. The inner hazard ring widens past the current exclusion zone.', riskZonesUrl: '/data/risk_forecast_2026-12-01.geojson' },
      { date: '2026-12-13', probability: 0.81, level: 'high', note: 'Predicted peak. Deformation crosses the threshold the model was fitted on.', riskZonesUrl: '/data/risk_forecast_2026-12-13.geojson' },
      { date: '2026-12-25', probability: 0.57, level: 'medium', note: 'The model has the source re-pressurising. Risk falls but stays well above the September baseline.', riskZonesUrl: '/data/risk_forecast_2026-12-25.geojson' },
    ],
    legend: {
      dark: 'Dark: smooth — fresh ash, water, bare ground',
      bright: 'Bright: rough — lava, vegetation, buildings',
      darker: 'Darker than baseline (smoother — new ash or water)',
      brighter: 'Brighter than baseline (rougher or newly exposed ground)',
      high: 'Ballistics and pyroclastic flow',
      medium: 'Ashfall',
    },
    story: [
      'An active volcano inside a 25 km caldera, on the fault that broke in the 2016 Kumamoto earthquake.',
      'Radar measures ground height to the millimetre through cloud and darkness. Aso’s eruptions have repeatedly followed the caldera floor sinking — so there is a signal to watch.',
      'Past "Now" the satellite has not flown yet, and the map switches from data to prediction.',
    ],
  },

  {
    id: 'earthquake',
    name: 'Kahramanmaraş, Türkiye',
    hazard: 'Strong aftershock',
    isSample: true,
    sources: ['USGS earthquake catalog', 'NISAR radar (ASF)', 'NASADEM elevation'],
    bounds: { west: 36.7, south: 37.0, east: 37.35, north: 37.62 },
    ...series('earthquake', [0.08, 0.09, 0.72, 0.58, 0.47, 0.41], [
      [0.38, 'medium', 'Aftershock rate is decaying on schedule, but stress has moved onto the unbroken segment to the north-east.'],
      [0.46, 'medium', 'Radar shows the north-east end of the rupture still creeping. The likely aftershock zone shifts that way.'],
      [0.33, 'medium', 'Creep slows. Odds fall back toward the long-term rate for this fault.'],
      [0.22, 'low', 'Ten weeks after the mainshock. Elevated, but no longer the main concern.'],
    ]),
    legend: {
      dark: 'Dark: smooth or shadowed — fault scarp, fresh landslide scars',
      bright: 'Bright: rough — city blocks, uplifted ground',
      darker: 'Darker than baseline (landslides, collapsed buildings)',
      brighter: 'Brighter than baseline (ground pushed up along the fault)',
      high: 'Strongest shaking expected',
      medium: 'Damaging shaking possible',
    },
    story: [
      'The East Anatolian Fault runs south-west to north-east through this box, past the city of Kahramanmaraş.',
      'The mainshock lands between the 2nd and 3rd pass. Use "Change since" from the first date to see the rupture line and the landslides it triggered on the slopes either side.',
      'The epicentre comes from the USGS catalog the backend already pulls. Radar adds where the ground actually moved.',
    ],
  },

  {
    id: 'wildfire',
    name: 'San Gabriel Mountains, California',
    hazard: 'Wildfire spread',
    isSample: true,
    sources: ['NASA FIRMS active fires', 'HLS optical imagery', 'GEOS-FP wind forecast', 'SMAP soil moisture'],
    bounds: { west: -118.35, south: 34.18, east: -117.85, north: 34.5 },
    ...series('wildfire', [0.12, 0.3, 0.55, 0.7, 0.78, 0.74], [
      [0.82, 'high', 'GEOS-FP shows a Santa Ana wind event. The front is pushed south-west toward the foothill suburbs.'],
      [0.88, 'high', 'Predicted peak. Fuel moisture from SMAP is at its seasonal low ahead of the front.'],
      [0.6, 'medium', 'Winds ease. The front slows at the foothills where the fuel runs out.'],
      [0.34, 'low', 'First winter storm in the forecast. Spread risk drops sharply.'],
    ]),
    legend: {
      dark: 'Dark: smooth — burn scar, bare ground',
      bright: 'Bright: rough — living chaparral, buildings',
      darker: 'Darker than baseline (burned — vegetation gone)',
      brighter: 'Brighter than baseline (regrowth or debris)',
      high: 'Active fire front',
      medium: 'Could burn if winds shift',
    },
    story: [
      'Steep chaparral above the Los Angeles basin. Santa Ana winds blow from the north-east and drive fires downslope toward homes.',
      'Smoke blinds optical satellites; radar sees straight through it. Burned slopes lose their vegetation and turn dark on every pass.',
      'FIRMS gives the hot spots, GEOS-FP the wind, SMAP how dry the fuel is. Together they move the predicted front.',
    ],
  },

  {
    id: 'flood',
    name: 'Sylhet, Bangladesh',
    hazard: 'River flooding',
    isSample: true,
    sources: ['GPM IMERG rainfall', 'NASADEM elevation', 'SMAP soil moisture'],
    bounds: { west: 91.6, south: 24.65, east: 92.1, north: 25.05 },
    ...series('flood', [0.2, 0.26, 0.45, 0.62, 0.75, 0.8], [
      [0.86, 'high', 'GPM shows heavy rain over the Meghalaya hills upstream. The Surma has not crested yet.'],
      [0.78, 'high', 'Crest passes Sylhet. Low-lying haor basins on both banks stay under water.'],
      [0.52, 'medium', 'Rain eases and the river falls, but the haors drain slowly.'],
      [0.28, 'low', 'Water retreats into the river channel and the permanent wetlands.'],
    ]),
    legend: {
      dark: 'Dark: smooth — open water reflects the radar away',
      bright: 'Bright: rough — paddies, villages, hills',
      darker: 'Darker than baseline (newly flooded)',
      brighter: 'Brighter than baseline (water receded, or flooded vegetation)',
      high: 'Under water now or within days',
      medium: 'Floods if the river rises further',
    },
    story: [
      'The Surma river runs west through Sylhet, just below the wettest hills on Earth.',
      'Open water is a mirror to radar and comes back almost black, so the flood shows as a dark sheet spreading from the river into the low haor basins.',
      'GPM measures the rain falling upstream; NASADEM says which ground is low enough to fill next.',
    ],
  },

  {
    id: 'landslide',
    name: 'Wayanad, Kerala, India',
    hazard: 'Landslide',
    isSample: true,
    sources: ['GPM IMERG rainfall', 'SMAP soil moisture', 'NASADEM elevation'],
    bounds: { west: 75.95, south: 11.3, east: 76.35, north: 11.65 },
    ...series('landslide', [0.15, 0.2, 0.36, 0.52, 0.66, 0.72], [
      [0.79, 'high', 'More heavy rain forecast on soil that is already saturated. New slides likely in the same three clusters.'],
      [0.7, 'high', 'Slopes below the large debris flow are undercut and still unstable.'],
      [0.46, 'medium', 'Rain tapers off. Soil starts to drain.'],
      [0.28, 'low', 'Dry season. Risk falls to background, except on fresh scars.'],
    ]),
    legend: {
      dark: 'Dark: smooth or facing away from the radar',
      bright: 'Bright: rough — fresh debris, boulders, landslide scars',
      darker: 'Darker than baseline (mud and water ponding)',
      brighter: 'Brighter than baseline (new landslide debris)',
      high: 'Slopes already failing',
      medium: 'Saturated steep ground',
    },
    story: [
      'Steep forested ridges in the Western Ghats, under the full force of the monsoon.',
      'Each slide strips the forest and leaves a rough track of boulders that comes back bright. Watch the count climb pass by pass, then the large debris flow on 14 Oct.',
      'Rain from GPM, soil saturation from SMAP and slope from NASADEM decide where the next one comes down.',
    ],
  },

  {
    id: 'drought',
    name: 'San Joaquin Valley, California',
    hazard: 'Severe drought',
    isSample: true,
    sources: ['SMAP soil moisture', 'GRACE groundwater', 'GPM IMERG rainfall'],
    bounds: { west: -119.95, south: 36.0, east: -119.35, north: 36.45 },
    ...series('drought', [0.3, 0.37, 0.45, 0.52, 0.6, 0.66], [
      [0.7, 'high', 'No rain in the GPM outlook. SMAP soil moisture keeps falling on the west side.'],
      [0.74, 'high', 'GRACE shows groundwater still declining, so pumping cannot cover the loss.'],
      [0.72, 'high', 'Fallowing spreads east across the valley.'],
      [0.66, 'medium', 'Early winter rain eases the surface, but groundwater stays low.'],
    ]),
    legend: {
      dark: 'Dark: smooth, dry bare soil',
      bright: 'Bright: wet soil and growing crops',
      darker: 'Darker than baseline (fields dried out or left fallow)',
      brighter: 'Brighter than baseline (irrigated or rained on)',
      high: 'Severe water shortage',
      medium: 'Moderate water shortage',
    },
    story: [
      'A grid of irrigated fields in one of the most productive farm valleys in the world.',
      'Wet soil and crops come back bright; dry, fallowed fields go dark. The west side, which relies on surface water deliveries, dries first.',
      'SMAP tracks soil moisture and GRACE tracks groundwater from space, the two numbers that decide how long the farms can hold out.',
    ],
  },

  {
    id: 'glacier',
    name: 'Jakobshavn Isbræ, Greenland',
    hazard: 'Glacier calving',
    isSample: true,
    sources: ['GRACE ice mass', 'HLS optical imagery'],
    bounds: { west: -50.25, south: 69.08, east: -49.35, north: 69.28 },
    ...series('glacier', [0.22, 0.28, 0.35, 0.44, 0.5, 0.55], [
      [0.58, 'medium', 'The front has retreated on every pass. Thinner ice near the front is starting to float.'],
      [0.66, 'high', 'Predicted large calving event. A wide section of the front breaks off and the fjord fills with icebergs.'],
      [0.6, 'medium', 'Winter sea ice starts to hold the mélange in place, slowing calving.'],
      [0.48, 'medium', 'Retreat slows but GRACE still shows the basin losing mass.'],
    ]),
    legend: {
      dark: 'Dark: smooth — open water, iceberg mélange',
      bright: 'Bright: rough — crevassed glacier ice, rock',
      darker: 'Darker than baseline (front retreated — ice became water)',
      brighter: 'Brighter than baseline (new crevasses or ice)',
      high: 'Calving and iceberg wave zone',
      medium: 'Iceberg-choked fjord',
    },
    story: [
      'The fastest-flowing glacier in Greenland, draining about 7% of the ice sheet into one fjord.',
      'Glacier ice is rough and bright; the water and broken ice it leaves behind is dark. The front creeps east, up the fjord, on every pass.',
      'Polar night hides it from optical satellites for months. Radar keeps working, and GRACE weighs how much ice the whole basin is losing.',
    ],
  },
].map((area) => ({ modelNote: PLACEHOLDER_NOTE, ...area }))

// Kept for anything that still expects a single study area.
export const studyArea = studyAreas[0]
