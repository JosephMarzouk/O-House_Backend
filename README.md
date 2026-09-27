# o-house-api

The O House backend (NestJS), and the **only** home for database migrations.

## How it works

- **The API owns sign-in (since 27 Sep); Supabase is only the database.** Logins live in
  `user_logins` (phone in E.164 or a lower-case email, bcrypt hash, lockout) and sessions in
  `refresh_tokens`. Both have RLS on and no client grants; only `src/auth/auth.module.ts` reads them,
  with the secret key.
- **Queries still run as the signed-in user.** The guard verifies our own access token (ES256, the
  club's `apiJwtKey`, 15 min, `iss=ohouse-api/<slug>`, `aud=ohouse`), then mints a 5-minute
  database JWT with the club's `dbSigningKey` (`role=authenticated`, its `kid`). Supabase trusts that
  key because it is imported as a **standby JWT key** in the dashboard. RLS, the RPC guards and
  `auth.uid()` work unchanged, and the API never bypasses them.
- **Clubs.** Every request names its club with an `X-Club` header, and that club's entry in the
  `CLUBS` registry is the only source of its URLs and keys. A club's Supabase project can live in any
  account.
- **Auth checks.** The per-club issuer means a club A token cannot be used at club B. The guard also
  requires a profile with a role, not deactivated. Routes are locked unless marked `@Public()`.
- **Several assignees.** A round can list several people (`submissions.assignee_ids`). The first to
  answer, attach evidence or submit claims it (`private.claim_assignment`); everyone else gets the
  422 refusal `ASSIGNMENT_TAKEN`. `inspector_id` is the owner, NULL until claimed.
- **Errors (`src/common/errors.filter.ts`).** Phones rely on this contract:
  - **422 `{refused: true, code}`:** only a known business refusal. The phone parks the op.
  - **401:** sign in again.
  - **Everything else, 503:** retry; the phone never drops the work.

| Route | |
|---|---|
| `GET /health` | Public; Railway's health check |
| `GET /clubs/host/:host` | Public; the portal: which club a host belongs to. (The staff app needs no lookup: each club has its own app build.) |
| `POST /auth/login` | Public, 10/min per IP. `{login, password}`: a login with `@` is an email, otherwise a phone (10 digits → `+20…`). 10 failures lock the login for 15 min. Returns the access token, a 30-day refresh token and the profile |
| `POST /auth/refresh` | Public. `{refreshToken}` → a new pair. The old one stays usable for 60 s (parallel tabs and requests); any later reuse revokes the whole family |
| `POST /auth/logout` | Public. `{refreshToken}` → revoked |
| `GET /auth/db-token` | The portal server only: needs header `x-ohouse-portal-key` = `PORTAL_GATEWAY_KEY`. Returns `{token, expiresIn, userId}`, the database JWT the portal queries Supabase with |
| `POST /admin/staff` | Admin/manager: `{name, phone?, email?, password, role}` (at least one of phone or email; password ≥ 8). The role pick follows the portal's grant rules; the portal sets department and manager afterwards |
| `POST /admin/staff/:id/password` | Admin/manager: set a password; revokes that person's sessions |
| `GET /me` | The signed-in profile (no phone), the club's branding, and `pages`: the About / Policies text an admin writes in the portal (`club_pages`) |
| `GET /assignments` | The phone's offline set: the last 7 days (Cairo), every future date, open follow-ups. Items included, paged past PostgREST's 1000-row cap. |
| `GET /assignments/:id` | One round, if RLS lets you see it, plus signed links (1 h) for its photos and signature |
| `POST /assignments/:id/items/:itemId/answer` | `{answer?, note?}` → `mark_item_done` |
| `POST /assignments/:id/items/:itemId/photos` | Multipart `file` + `photoId` (uuid): a JPEG (≤ 5 MB) or an MP4 video from the camera (≤ 50 MB, checked by its `ftyp` bytes). The API stores it at `photos/{id}/{itemId}-{photoId}.jpg` or `.mp4`, then `attach_item_photo` |
| `POST /assignments/:id/submit` | Multipart `file` (PNG, ≤ 1 MB), `signatureId`, `completedAt` (ISO-8601 **with offset**), `note?` → `submit_assignment` |
| `PATCH /me/locale` | `set_locale`. (No password route: staff never change their password in the app; only an admin sets it, in the portal.) |
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

## Keys (own sign-in, per club)

Each `CLUBS` entry needs two ES256 private JWKs (see `railway.env.template`):

- **`apiJwtKey`:** signs our access tokens. Nobody else ever needs it.
- **`dbSigningKey`** (with a `kid`): signs the database JWTs. Import it into that club's Supabase
  project as a **standby** key (Project Settings → JWT Keys → import a private key; paste only the JWK
  fields). Never rotate it to "current" unless you decide what Supabase Auth itself should sign with.
  Until it is imported, every query fails with 401.

Plus `PORTAL_GATEWAY_KEY` (the portal's `OHOUSE_GATEWAY_KEY` must match).

**Cutover:** `select private.copy_auth_logins();` copies logins and password hashes from
`auth.users` again (newer hash wins). Run it right before the old portal and app are retired, so a
password changed there in the meantime is not lost.
