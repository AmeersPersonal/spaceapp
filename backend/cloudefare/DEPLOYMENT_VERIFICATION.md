# Deployment verification

Target: https://earth-replay-api.jc-cloudflare-a56b8c1d.workers.dev

## Current release — November 15, 2026

Source: `2047d80` on `main`. Active Worker version:
`6957adc2-26c2-475b-b0b1-83c71967f904` (100% of traffic).
Deployment: `eee1df29-c960-407d-9d64-340d846e118a`.
Verified at approximately 2026-11-15 09:01 UTC / 04:01 EST.

Published with `npm run deploy`, explicitly selecting `wrangler.production.jsonc`,
`--keep-vars` and `--containers-rollout none`. The previous version was
`33bf1c32-efe8-4412-81de-fd410c39c619`. No database migrations, secret changes or
processor image releases were performed.

- Frontend lint/build and all 266 backend tests across 18 files passed before publication.
- Live metadata matched all 17 existing plain-text variables, 10 resource bindings
  and 11 secret binding names. Durable Object namespaces, migration tag `v2`,
  asset routing and processor image/capacity were preserved.
- Root HTML and its JS/CSS assets returned 200 and matched the freshly built
  local files byte for byte. `/events` also served the app successfully.
- Catalog (10 events), event detail, agent roster and dataset configuration returned 200.
- Anonymous profile, private chat list and Ask returned 401. Login returned 302
  to the expected Auth0 tenant with the existing production callback URL.
- An isolated browser rendered the public NISAR map and Events page (10 event
  links), switched across all seven sample scenarios, exercised forecast/change
  controls and passed mobile overlap checks. No runtime exceptions were observed.

Known limits: the existing tile-template encoding bug in `Frontend/src/NisarMap.jsx`
remains; no new processor job or signed-in AI conversation was exercised during
this release. Signed-out map browsing is restricted to Japan, and production
currently has no Japan catalog entries, so its empty-state message is expected.
The earlier private-auth persistence check below is historical evidence.

## Historical release — November 14, 2026

Worker version: `1ca56909-55b9-4f03-9b8d-ca34b24d42e4` (100% of traffic at that time; deployed 2026-11-15 00:00 UTC / November 14 EST).

### Deployment

- Fresh backend suite: 203 tests passed across 14 files.
- Wrangler deployment dry run passed; `git diff --check` passed.
- Verified Auth0 client callback/logout allowlists match the production Worker.
- Added Auth0 domain/client ID and production APP_BASE_URL to Wrangler config.
- Uploaded the Auth0 client secret through stdin and generated a production-only session encryption key. Secret values were not printed or committed.
- Inspected the remote migration ledger/schema before applying both `0002_chat_stats.sql` and `0002_chats.sql`. Existing catalog data was preserved; a follow-up check confirms no pending migrations.
- Deployed with project-local Wrangler and `--keep-vars`, preserving existing production vars/secrets. Existing queues, workflow, cron, Durable Object, AI, Vectorize, D1, KV and R2 bindings remain configured.

### Live API checks

| Check | Observed |
|---|---|
| Root, event catalog, agents, dataset configuration | 200 |
| Auth0 login | 302 to configured tenant |
| Anonymous profile and owned chat list | 401 |
| Anonymous `/api/ask` | 401 |
| Callback without matching transaction | 400 |
| Specialist chat with a real AI response | 200 |
| Stored specialist conversation retrieval | 200; at least user and assistant messages |
| Event summary | 200 |
| Event forecast | 200 |

### Real browser persistence check

The production browser E2E passed on 2026-11-14 (EST). Real Auth0 login established Secure/HttpOnly/SameSite=Lax session cookies. Two owner-scoped chats each saved two user/assistant AI turns. After the user confirmed Auth0's logout page, the session cookie was absent and profile, chat reads and AI writes returned 401. A second real login returned the same Auth0 subject and restored both histories exactly, including message IDs, content, ordering and metadata. A follow-up generated another user/assistant pair; the first chat then had six messages after a page reload. The same isolated browser profile was reopened between logout and re-login. No forged sessions or mocked providers were used for this browser check.

Auth0 presents `/oidc/logout/confirm` with Yes/No controls. The first runner expected an immediate redirect and stopped there; allowing the confirmation and resuming the same profile completed the check. This required a test-runner adjustment, not an application-code change. Four labeled test chats were created across attempts and retained; the final successful run verified chats `chat_6cb44504-9c7c-40f5-ad51-a581f5bb337b` and `chat_1236a2cf-44bd-4d19-84aa-24671b6d2f6f`. Credentials, cookies and private message content are omitted from this report. The unrelated public specialist check also created a test thread.

Completed: 2026-11-15T00:08:34.705Z

### Limits at the time

The frontend sign-in page still has a backend integration TODO; the browser runner exercises the deployed Worker directly. Credentialed cross-origin frontend access needs an explicit CORS allowlist and compatible same-site cookies. The external SAR processor is absent; successful raster/tile production is not verified. Public specialist `/api/chat` threads remain separate from Auth0-owned `/api/chats`.
