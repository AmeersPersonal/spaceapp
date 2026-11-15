# spaceapp — Repository Spec

## Scope

Defines what the repository as a whole guarantees, and the rules that hold
across folder boundaries.

## Repository layout contract

```
/                       repo root
  Frontend/             the web app — self-contained, has its own package.json
  README.md
```

The `backend/` folder exists on `main` and `backend-exp`, not on `frontend1`.
No code in `Frontend/` may import from, or assume the existence of, anything
outside `Frontend/`.

## Branches

| Branch | Holds |
| --- | --- |
| `main` | `backend/` |
| `frontend1` | `Frontend/` (this checkout) |
| `backend-exp` | backend experiments |
| `jeffrey/additional_datasets` | dataset work |
| `jeffrey/data-experiment-clean` | dataset work |

## Cross-cutting invariants

1. **Observed and predicted must stay visually distinguishable.** Any feature
   that displays a value must make clear whether it came from a satellite pass
   or from the model. This is a correctness requirement, not a styling
   preference — the app's purpose is defeated if a viewer reads a forecast as
   an observation.

2. **`src/studyArea.js` is the only configuration surface.** Swapping study
   area, dates, images, risk numbers or forecast must require editing that one
   file plus dropping files into `public/data/`. No component may hard-code a
   date, a coordinate, a filename or a hazard name.

3. **Sample data must announce itself.** While `studyArea.isSample` is `true`
   the UI shows a "Sample data" badge. It is set to `false` only when every
   image and every number in `studyArea.js` is real.

4. **Dates are ISO `YYYY-MM-DD` strings everywhere** — in `studyArea.js`, in
   generated filenames, in GeoJSON filenames. Parsing happens once, in
   `formatDate()` in `mapview.jsx`.

5. **Acquisition dates are 12 days apart**, matching NISAR's repeat cycle.
   Nothing enforces this in code; it is a data-authoring rule.

## Frontend/backend boundary

There is currently no backend integration. Two call sites are marked for it:

- `src/pages/SignIn.jsx` — `// TODO: call backend auth endpoint`
- `src/pages/SignUp.jsx` — `// TODO: call backend registration endpoint`

Both currently `console.log` the submitted values and navigate away. **No
authentication exists.** Nothing in the app is access-controlled; the sign-in
and sign-up routes are UI shells.

## Known gaps

- `README.md` is a single line.
- `src/index.css` is empty (imported by `main.jsx`, contributes nothing).
- Passwords are logged to the console in the auth forms — remove before any
  deployment.
- No tests, no CI.
- `npm run lint` runs oxlint; it is the only automated check.
