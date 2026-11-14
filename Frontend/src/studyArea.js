// studyArea.js — everything specific to your study area lives here.
// When your real NISAR data and your model output are ready, this is the
// only file you need to edit.

export const studyArea = {
  name: 'Mount Aso, Japan',
  hazard: 'Volcanic eruption',

  // true shows a "Sample data" badge on the map. Set to false once the
  // images and the forecast below are real.
  isSample: true,

  // Free base map, no API key.
  basemapStyle: 'https://tiles.openfreemap.org/styles/liberty',

  // The rectangle your radar images cover, in degrees.
  // Every image in `dates` must cover exactly this rectangle.
  // This box holds the whole Aso caldera (18 km east-west, 25 km
  // north-south) with Nakadake, the active vent, near the centre.
  bounds: { west: 130.85, south: 32.7, east: 131.35, north: 33.06 },

  // ---------- THE PAST: what the satellite actually saw ----------
  // One entry per acquisition date, oldest first. Dates are 12 days apart
  // because that is NISAR's repeat cycle.
  // Images go in Frontend/public/data/ and should be greyscale PNGs
  // (brighter = stronger radar return), all the same pixel size.
  //
  // `risk` is optional: your measured risk index for that date, 0 to 1.
  // It draws the solid part of the risk curve in the side panel. Leave it
  // out and that date is simply skipped on the curve.
  dates: [
    { date: '2026-09-08', image: '/data/radar_2026-09-08.png', risk: 0.1 },
    { date: '2026-09-20', image: '/data/radar_2026-09-20.png', risk: 0.17 },
    { date: '2026-10-02', image: '/data/radar_2026-10-02.png', risk: 0.26 },
    { date: '2026-10-14', image: '/data/radar_2026-10-14.png', risk: 0.35 },
    { date: '2026-10-26', image: '/data/radar_2026-10-26.png', risk: 0.44 },
    { date: '2026-11-07', image: '/data/radar_2026-11-07.png', risk: 0.52 },
  ],

  // Zones derived from the observed dates above, as GeoJSON polygons.
  // Each polygon needs a "risk" property of "high" or "medium".
  // high = ballistics and pyroclastic flow, medium = ashfall.
  riskZonesUrl: '/data/risk_zones.geojson',

  // ---------- THE FUTURE: what your model predicts ----------
  // These dates have no radar image yet — that is the whole point. The
  // slider runs straight past today into this list, and the map switches
  // from showing data to showing the prediction.
  //
  //   date          when the model is predicting for
  //   probability   0 to 1, how likely the hazard is on that date
  //   level         'high' | 'medium' | 'low', used for the label colour
  //   note          one line for the panel: what is driving the number
  //   riskZonesUrl  optional. The predicted extent for that date. Falls
  //                 back to riskZonesUrl above when left out.
  //
  // ALL NUMBERS BELOW ARE PLACEHOLDERS. Replace them with model output.
  forecast: [
    {
      date: '2026-11-19',
      probability: 0.44,
      level: 'medium',
      note: 'The caldera floor has dropped on each of the last four passes, and the rate is still increasing.',
      riskZonesUrl: '/data/risk_forecast_2026-11-19.geojson',
    },
    {
      date: '2026-12-01',
      probability: 0.62,
      level: 'high',
      note: 'Subsidence spreads beyond the central cones. The inner hazard ring widens past the current exclusion zone.',
      riskZonesUrl: '/data/risk_forecast_2026-12-01.geojson',
    },
    {
      date: '2026-12-13',
      probability: 0.81,
      level: 'high',
      note: 'Predicted peak. Deformation crosses the threshold the model was fitted on.',
      riskZonesUrl: '/data/risk_forecast_2026-12-13.geojson',
    },
    {
      date: '2026-12-25',
      probability: 0.57,
      level: 'medium',
      note: 'The model has the source re-pressurising. Risk falls but stays well above the September baseline.',
      riskZonesUrl: '/data/risk_forecast_2026-12-25.geojson',
    },
  ],

  // Shown in the panel under the forecast, so nobody mistakes a prediction
  // for a measurement.
  modelNote: 'Placeholder forecast. Swap in your model output in studyArea.js.',

  // Text for the side panel. Explain what the viewer is seeing and why.
  story: [
    'An active volcano inside a 25 km caldera, on the fault that broke in the 2016 Kumamoto earthquake.',
    'Radar measures ground height to the millimetre through cloud and darkness. Aso’s eruptions have repeatedly followed the caldera floor sinking — so there is a signal to watch.',
    'Past "Now" the satellite has not flown yet, and the map switches from data to prediction.',
  ],
}
