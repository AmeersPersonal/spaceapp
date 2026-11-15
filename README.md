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

Set `FRONTEND_URL=http://localhost:5173/` and the Auth0 values in `backend/cloudefare/.dev.vars` for sign-in ([AUTH0.md](backend/cloudefare/AUTH0.md)). To browse the deployed catalog without a local Worker, set `VITE_API_TARGET` in `Frontend/.env.local` (see `Frontend/.env.example`); sign-in needs the local Worker.

The home map has two sources, chosen with the switch at the top. **NISAR data** reads the backend catalog: processed tile layers when they exist, otherwise ASF's preview image of each catalogued scene, placed using the scene footprint the ingest stores. **Sample data** is the bundled Mount Aso demo. Scenes ingested before migration `0004_scene_bounds.sql` have no footprint until they are ingested again.

Who sees what on the NISAR map: **signed-out visitors** get Japan highlighted (the rest of the world dimmed) and only Japan's events; clicking elsewhere asks them to sign in. **Signed-in users** can click any place: the app searches a 1° box around it for NISAR scenes (last 90 days), nearby M4.5+ earthquakes and other NASA datasets, lists catalog events that cover the spot, and can start tracking the area or an earthquake. The sign-in rule is enforced in the app only: the read endpoints behind these searches are public, and only starting a track (`POST /api/ingest`, `POST /api/events/earthquake`) needs a session.
## Local development notes

Node.js 22.22.0 and npm 10.9.4 are available on this machine. Dependencies are installed for both apps. To restart, run these in separate terminals from the repository root:

```sh
npm --prefix backend/cloudefare run dev
```

```sh
npm --prefix Frontend run dev
```

Open **http://localhost:5173/** (use `localhost` for both servers so Auth0 cookies share the host). Backend secrets are in ignored `backend/cloudefare/.dev.vars`; the frontend's ignored `.env.local` contains only `VITE_API_TARGET=http://localhost:8787`.

Local D1 migrations have been applied. For a fresh checkout, install dependencies in both directories with `npm ci`, configure `.dev.vars`, then run `npm --prefix backend/cloudefare run db:migrate:local` before starting.

Local D1, R2, KV, queues, workflows and replay rooms are separate from production. The local catalog starts empty: choose **Sample data** to explore the bundled demo, or sign in and ingest real scenes. Workers AI uses the authenticated Cloudflare account remotely. Vectorize is not configured for remote use, so semantic search is unavailable locally. `PROCESSOR_URL` is empty and no Python processor is included in this checkout; new scene processing waits for an external processor. These two features require additional service setup. A real browser sign-in remains a manual check; the local Auth0 redirect is verified.

### Replay, search period, outlook and pictures

- **Replay.** Any event with two or more scene dates plays from its first date: speed (0.5× to 4×), loop, and for earthquakes how many days before or after the quake each date is. Signed-in users can also replay what a search found, or a nearby past earthquake (36 days before to 60 days after it), without tracking anything. The Events page links to `/?event=ID&replay=1`.
- **Search period.** The area search and the Events list take a date range, the last 6 months by default. Searches span at most 366 days.
- **Outlook.** The map's Outlook button shades grid cells by the chance of at least one M4.5+ earthquake in the next 7, 30 or 90 days, from the past year's USGS catalog (a Poisson rate). An AI model writes scenario text for the busiest cells from those numbers. It is modeled, never an observation, and does not predict a specific earthquake.
- **Pictures.** Each event page shows USGS impact maps for earthquake events, related NASA photos and links to more. NASA photos are a library search by place and hazard, so they can show earlier disasters there.

### Hosting

The deployed Worker serves the built app as static assets, so the app, `/api`, `/auth` and `/tiles` share one origin: <https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev>. `npm run deploy` in `backend/cloudefare` builds `Frontend/dist` and deploys both. It needs the `assets` block and `"keep_vars": true` in the local, untracked `wrangler.jsonc`:

```jsonc
"keep_vars": true,
"assets": {
  "directory": "../../Frontend/dist",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/", "/api/*", "/auth/*", "/tiles/*"]
}
```

Browsers on `/` get the app and API clients still get the JSON service description. A finished sign-in returns to `/`.

## Data credits
Japan's outline: [Natural Earth](https://www.naturalearthdata.com/) 1:50m admin-0 countries (public domain).

NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by the Alaska Satellite Facility (ASF DAAC). AI-generated captions and answers are labeled as hypotheses and are not verified interpretations.
