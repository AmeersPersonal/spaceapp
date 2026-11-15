# spaceapp — Earth Replay

Backend for NASA Space Apps 2026, *Dancing with the SARs*. It tracks real surface change with NASA-ISRO NISAR radar data.

- Architecture and scope: [backend/SPEC.md](backend/SPEC.md)
- Cloudflare Worker API: [backend/cloudefare/SPEC.md](backend/cloudefare/SPEC.md)

```sh
cd backend/cloudefare
npm install
npm test        # local Vitest in workerd, no external calls
npm run dev     # wrangler dev (copy .dev.vars.example to .dev.vars first)
```

## Frontend

React + Vite app in [Frontend/](Frontend/). Its dev server forwards `/api`, `/auth` and `/tiles` to the Worker, so run both:

```sh
cd backend/cloudefare && npm run dev   # API on http://localhost:8787
cd Frontend && npm install && npm run dev   # app on http://localhost:5173
```

Set `FRONTEND_URL=http://localhost:5173/` and the Auth0 values in `backend/cloudefare/.env.local` for sign-in ([AUTH0.md](backend/cloudefare/AUTH0.md)). To browse the deployed catalog without a local Worker, set `VITE_API_TARGET` in `Frontend/.env.local` (see `Frontend/.env.example`); sign-in needs the local Worker.

The home map has two sources, chosen with the switch at the top. **NISAR data** reads the backend catalog: processed tile layers when they exist, otherwise ASF's preview image of each catalogued scene, placed using the scene footprint the ingest stores. **Sample data** is the bundled Mount Aso demo. Scenes ingested before migration `0004_scene_bounds.sql` have no footprint until they are ingested again.

## Data credits
NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by the Alaska Satellite Facility (ASF DAAC). AI-generated captions and answers are labeled as hypotheses and are not verified interpretations.
