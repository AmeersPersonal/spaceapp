# Persistent chat storage

## Plan and contract

Store chat ownership as the verified Auth0 `sub`, independently of expiring browser sessions. No password, token or local users table is needed. Keep the existing replay session reducer intact, and add HTTP session policy to `sessionManger.js`; Auth0 still verifies identity.

- Add D1 migration `0002_chats.sql` for owned chats and ordered messages, with indexes and cascading chat/message relationships.
- Add authenticated create/list/detail and message append/list endpoints in `chats.js`. Clients may append user messages only. Titles are at most 120 characters; messages are at most 8,000. List pages are bounded to 100 rows.
- Add optional `chatId` to `/api/ask`. Verify ownership and event matching before AI work; include bounded prior history and atomically save user/assistant messages only after a successful answer. Do not use shared KV or AI Gateway answer caches for private conversations.
- Test login requirements, cross-user isolation, persistence across new login cookies, validation, pagination, assistant-role spoofing, AI failure, atomic message pairs and continuation context. Run the full suite and deployment dry run; apply the migration locally only.

## Endpoints

All routes below require an Auth0 session and return `Cache-Control: no-store`. Use `credentials: 'include'` from the frontend. Writes require JSON and the configured origin policy. Ownership is derived from the session; frontend-supplied user IDs never grant access.

| Route | Request / response |
|---|---|
| `POST /api/chats` | `{title?,eventId?}` → 201 `{chat}`. Default title is `New chat`; optional event must exist. |
| `GET /api/chats?limit=20&page=1` | `{chats,hasMore}` ordered newest updated first. Limit 1–100, page 1–10000. |
| `GET /api/chats/:id` | `{chat}` or 404 for missing/other-user chats. |
| `POST /api/chats/:id/messages` | `{content}` → 201 `{message}`; user role only. Use for manually stored user notes/messages. |
| `GET /api/chats/:id/messages?limit=50&after=0` | `{messages,nextAfter,hasMore}` ordered by increasing sequence. Limit 1–100, after a nonnegative safe integer. |
| `POST /api/ask` | Existing `{eventId,question}` plus optional `chatId`. With a chat, event must match its stored event. Returns existing answer plus `chatId` and `messageIds:{user,assistant}`. Saves the pair automatically; do not also append the question manually. |

Chats without an event support manual message storage. Create an event-bound chat to use `/api/ask` continuation. Assistant messages can only be written by the backend. Stored assistant metadata preserves sources, AI disclaimer, model and credit. The last 20 messages, bounded to 20,000 characters, enter the AI context. History informs conversational follow-ups, while the system still grounds factual answers in catalog context.

## Deployment

Apply `npm run db:migrate:local` for local use. Both chat migrations have now been applied remotely, followed by deployment of the merged source with the Auth0 production configuration described in [AUTH0.md](AUTH0.md). Future rollouts must inspect migration state and apply pending migrations before deployment. History survives session expiry, logout and a new browser login with the same Auth0 `sub`. Session revocation/listing and chat history are distinct concerns; server-side login-session storage is not added.

Concurrent requests save whole user/assistant pairs atomically in completion order. They can generate against the same prior history; strict per-chat generation serialization and request retry deduplication are not implemented. Storage access remains owner-scoped. Chat count/retention quotas, deletion/export APIs and frontend UI are future work.

## Verification

All 157 backend tests passed across 11 files on 2026-11-14. The deployment dry run built successfully. Local migrations 0001 and 0002 applied successfully; production was not changed. Independent review found no blocking security/correctness issues.

## Production E2E verification (2026-11-14)

The production browser E2E passed on 2026-11-14 (EST). Real Auth0 login established Secure/HttpOnly/SameSite=Lax session cookies. Two owner-scoped chats each saved two user/assistant AI turns. After the user confirmed Auth0's logout page, the session cookie was absent and profile, chat reads and AI writes returned 401. A second real login returned the same Auth0 subject and restored both histories exactly, including message IDs, content, ordering and metadata. A follow-up generated another user/assistant pair; the first chat then had six messages after a page reload. The same isolated browser profile was reopened between logout and re-login. No forged sessions or mocked providers were used for this browser check.

Both chat migrations are now applied remotely and the merged backend is deployed. See [DEPLOYMENT_VERIFICATION.md](DEPLOYMENT_VERIFICATION.md) for evidence and remaining frontend/processor limits.
