# o-house-api

The O House backend (NestJS), and the **only** home for database migrations.

## How it works

- **Queries run as the signed-in user.** Every request carries the user's Supabase token, and the API
  forwards it. RLS and the RPC guards stay the authority, and the API never bypasses them.
- **Clubs.** Every request names its club with an `X-Club` header, and that club's entry in the
  `CLUBS` registry is the only source of its URLs and keys. A club's Supabase project can live in any
  account.
- **Auth.** The global guard verifies the token against that club's JWKS and checks the issuer, so a
  club A token cannot be used at club B. It also requires a profile with a role, not deactivated.
  Routes are locked unless marked `@Public()`.
- **Errors (`src/common/errors.filter.ts`).** Phones rely on this contract:
  - **422 `{refused: true, code}`:** only a known business refusal. The phone parks the op.
  - **401:** sign in again.
  - **Everything else, 503:** retry; the phone never drops the work.

| Route | |
|---|---|
| `GET /health` | Public; Railway's health check |
| `GET /clubs/host/:host` | Public; the portal: which club a host belongs to. (The staff app needs no lookup: each club has its own app build.) |
| `GET /me` | The signed-in profile (no phone) and the club's branding |
| `GET /assignments` | The phone's offline set: the last 7 days (Cairo), every future date, open follow-ups. Items included, paged past PostgREST's 1000-row cap. |
| `GET /assignments/:id` | One round, if RLS lets you see it, plus signed links (1 h) for its photos and signature |
| `POST /assignments/:id/items/:itemId/answer` | `{answer?, note?}` → `mark_item_done` |
| `POST /assignments/:id/items/:itemId/photos` | Multipart `file` (JPEG, ≤ 5 MB) + `photoId` (uuid). The API stores it at `photos/{id}/{itemId}-{photoId}.jpg`, then `attach_item_photo` |
| `POST /assignments/:id/submit` | Multipart `file` (PNG, ≤ 1 MB), `signatureId`, `completedAt` (ISO-8601 **with offset**), `note?` → `submit_assignment` |
| `PATCH /me/locale` · `POST /me/password-changed` | `set_locale` · `complete_password_change` |
| `POST /sync/refusals` | `{op, code, message?, assignmentId?, itemId?}`: a refusal the phone decided itself (e.g. a purged file) |

**Writes.** Send an `Idempotency-Key` (uuid, fixed when the op was queued). Repeats are harmless: the
evidence path comes from ids fixed at capture, and the RPCs ignore work they already have. Every 422
is recorded in `sync_refusals` (the user's own, their manager's reports, admins all), keyed by that
header so a retried refusal is recorded once. Photo and signature uploads use the secret key only after
reading the round as the user and checking they are its assignee.

## Run

Needs **Node 22+**. supabase-js needs Node 22's built-in WebSocket, and the API refuses to boot
without it.

```bash
pnpm install
pnpm test
pnpm build && CLUBS='{...}' node dist/main.js   # see .env.example for the CLUBS shape
```

**Railway:** connect the repo; `railway.json` holds the build, start and health check. Set `CLUBS` in
the service variables, and use an always-on service in an EU region.

## Migrations

`supabase/migrations/` is the ledger. Every schema change is a file here, applied with the Supabase
CLI. Nothing is pasted into the SQL Editor except reads and the manual Owner promotion. The legacy
`schema.sql` from the old web client is retired: running it reverted the security hardening once.

Linking and the baseline are one-time steps. `login` needs your access token, and `link` asks for
the database password:

```bash
npx supabase login
npx supabase link --project-ref ptonujazlljpkgpfrkpw
npx supabase db pull              # writes <timestamp>_remote_schema.sql = the live schema
                                  # (20260923105225_restore_role_guards is already applied and matches)
npx supabase migration list       # local and remote must match
```

## Keys (Step 0)

- **API secret key:** Supabase Dashboard → Project Settings → API Keys → create a secret key named
  `o-house-api`. It goes only into Railway's variables for the API service.
- **Gateway key:** generate it locally, and store it only in Railway (API and portal services):

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

  Its SHA-256 is inserted into `private.gateway_keys` when the gate ships (Step 4). Never commit the
  key.
