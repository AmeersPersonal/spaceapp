# src/pages — Spec

## Current integration

The original form descriptions below are historical. Current sign-in and
sign-up pages hand off to Auth0 through `/auth/login`; `auth.jsx` supplies
session state and the forms never collect or log passwords.

`Home` switches between `NisarMap` and the seven-area sample `MapView`.
`Home.css` keeps the sample scenario picker below the date/sample badges
and includes the phone/touch rules from the live-map branch. On phones,
the sample prompt follows the measured bottom of the scenario picker,
leaving the picker, attribution and playback controls clear.

`Events` is registered at `/events` and `/events/:eventId`. It supports the
date-range catalog, scene metadata, regional context, AI briefing, pictures
and the signed-in question flow. The other routes remain `/`, `/signin`,
`/signup` and the not-found fallback.

Verification: frontend lint/build plus desktop and phone browser checks of
both map modes, sample scenario selection and the observation/forecast
controls. The merge retains existing responsive spacing and adds no new
dependencies or API contracts.

## Changelog

- 2026-11-15 - Preserve the sample scenario picker and live-map mobile rules together; keep the phone prompt clear of the picker and playback controls.

## Component contract

Every page component:

- is a function component with no props
- is the default export of its file
- returns a single `<section className="page">` root
- imports no CSS (styling lives in `App.css`)
- is registered in `App.jsx`'s `<Routes>`

## Routes

| Path | Component | Renders |
| --- | --- | --- |
| `/` | `Home` | `<h1>` + `<MapView />` |
| `/signin` | `SignIn` | Auth form |
| `/signup` | `SignUp` | Registration form |
| `*` | `NotFound` | 404 + link home |

Adding a page means creating the file here and adding a `<Route>` in
`App.jsx`. The navbar in `App.jsx` is separate and is not generated from the
route table.

## Form specifications

### SignIn

| Field | State | Validation |
| --- | --- | --- |
| Email | `email` | `type="email"`, `required` |
| Password | `password` | `required` |

On submit: `preventDefault()` → `console.log('Sign in', { email })` →
`navigate('/')`.

### SignUp

| Field | State | Validation |
| --- | --- | --- |
| Name | `name` | `required` |
| Email | `email` | `type="email"`, `required` |
| Password | `password` | `required`, `minLength={8}` |
| Confirm Password | `confirm` | `required` |

Plus one JS check: `password !== confirm` sets `error` to
`'Passwords do not match'` and aborts. The error renders in a `<p className="error">`.

On success: clears `error` → `console.log('Sign up', { name, email })` →
`navigate('/signin')`.

## Security requirements — currently unmet

1. **No authentication exists.** Both handlers are stubs. Treat every route as
   public.
2. **Passwords are in component state and the forms log submissions.** The
   logged objects exclude the password field, but the state holds it in
   plaintext for the page's lifetime. Remove all `console.log` calls before
   any deployment.
3. **No CSRF, rate limiting, or session handling** — there is no server to
   have them.
4. Password policy is `minLength={8}` client-side only, trivially bypassed.

## When wiring the backend

Replace the two `// TODO` comments with real calls. At minimum each handler
will need:

- an async submit handler with a loading state (none exists today)
- error handling for a rejected request, rendered the way `SignUp` already
  renders its mismatch error
- somewhere to put the returned session; there is no auth context, provider or
  storage in the app yet, so that has to be built
- route guarding, if any route is ever meant to be private

## Known dead code

- `Home.jsx` imports `Link` from `react-router-dom` and never uses it.
- `NotFound.jsx` has a stray blank line where a message presumably belonged.
