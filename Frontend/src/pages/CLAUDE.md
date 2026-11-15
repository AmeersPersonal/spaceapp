# CLAUDE.md — src/pages

The four route components. All small; none holds shared state.

See `spec.md` here for the component contract, field-level form specs and the
security gaps.

| File | Route | What it is |
| --- | --- | --- |
| `Home.jsx` | `/` | A heading and `<MapView />`. The real app. |
| `SignIn.jsx` | `/signin` | Email + password form. |
| `SignUp.jsx` | `/signup` | Name, email, password, confirm. |
| `NotFound.jsx` | `*` | "404" and a link home. |

## Conventions to follow

Every page component:

- is a function component with no props
- is the default export of its file
- returns a single `<section className="page">` root
- imports no CSS — styling comes from `App.css`
- is registered in `App.jsx`'s `<Routes>`

Adding a page means creating the file here **and** adding a `<Route>` in
`App.jsx`. The navbar is hand-written in `App.jsx` and is not generated from
the route table, so link it there too if it should be navigable.

## The auth pages authenticate nothing

Both are complete, working forms whose submit handlers `console.log` and
navigate away. Each carries a `// TODO: call backend auth endpoint` comment
marking where the real call belongs.

**There is no auth anywhere in the app.** No context, no provider, no storage,
no route guarding. `/` renders the map regardless, and signing in changes no
state that survives the navigation. Do not write code that assumes a session
exists.

`SignUp` does have one real check — `password !== confirm` sets an inline
error and aborts. Match that pattern if you add validation.

## Before wiring a backend

Each handler will need an async submit with a loading state (neither has one),
error handling rendered the way `SignUp` renders its mismatch error, somewhere
to put the returned session, and route guarding if any route becomes private.
None of that infrastructure exists yet.

**Remove the `console.log` calls** in both handlers at that point.

## Dead code present

- `Home.jsx` imports `Link` and never uses it.
- `NotFound.jsx` has a stray blank line where a message presumably belonged.

## Layout note

`Home.jsx` wraps `MapView` in `.page`, which `App.css` styles as a centred
column with 4rem padding — so the map sits in a centred, padded container
rather than filling the viewport. Change `.page` or stop using it here if you
want a full-bleed map.
