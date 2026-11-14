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

## Data credits
NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by the Alaska Satellite Facility (ASF DAAC). AI-generated captions and answers are labeled as hypotheses and are not verified interpretations.
