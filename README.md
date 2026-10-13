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
  requires a profile with a role (`profiles.role_id`), not deactivated. Routes are locked unless
  marked `@Public()`.
- **Roles and permissions (since 29 Sep) live in the database.** Each club has its own roles
  (`roles`, `role_permissions`, `role_departments`, `role_assignable`), built from a fixed catalog
  (`permissions`, 30 keys such as `checklists.create`). Every policy and RPC guard asks
  `has_permission(key)` and the scope helpers (own / team / chosen departments / whole club); the
  API adds no role logic of its own. See "Roles" below.
- **Several assignees.** A round can list several people (`submissions.assignee_ids`). The first to
  answer, attach evidence or submit claims it (`private.claim_assignment`); everyone else gets the
  422 refusal `ASSIGNMENT_TAKEN`. `inspector_id` is the owner, NULL until claimed.
- **Push notifications (since 12 Oct, `src/notifications/`).** Each club is its own Firebase project;
  the API sends through FCM with that club's `fcmServiceAccount` (see Keys). The database queues: a
  trigger on `submissions` adds E1 (new round), E5 (sent back) and E8 (follow-up, to the manager) to
  `notifications`; every minute the API calls `enqueue_due_notifications()` for E3 (30 min before the
  deadline) and E4 (overdue, to the workers and their manager). Every 5 s the worker claims up to 100
  rows (`claim_notifications`, SKIP LOCKED), renders them in the person's language (Arabic when unset),
  sends one summary per person per planner save, retries with backoff (30 s → 4 min, then `failed`),
  skips rows over an hour old, and deletes tokens FCM calls unregistered. The row keeps the title and
  body it was sent with. A club without a key boots with its worker idle.
- **Report emails (since 13 Oct, `src/reports/`).** At 23:30 Cairo time the API mails each department's
  checklist report (a PDF) to the addresses an admin typed on the portal's Club settings, plus one "All
  departments" report to a separate list. The admin picks daily, weekly (Saturday to Friday, sent on
  Friday) or off. A worker wakes every 60 s; `duePeriod()` decides whether a report is due;
  `claim_report_mail` hands each (period, department) to one API instance only; a failure is tried again
  twice, 5 minutes apart. `sendReport()` asks the portal for `/reports/daily/summary` (JSON) and
  `/reports/daily/pdf` with a 15-minute token minted for the admin who saved the settings (`set_by`), so
  a report never shows more than that admin can see. The body is a short English and Arabic brief; the
  details are in the PDF. Mail goes through Microsoft Graph (`graph.ts`, no SDK) from one mailbox per
  club, set on Club settings. Each send's outcome is in `report_mail_log`. A club without `mail` in
  `CLUBS` gets no report emails.
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
| `POST /admin/staff` | `{name, phone?, email?, password, roleId, departmentId?}` (at least one of phone or email; password ≥ 8). Allowed only if `can_assign_role(roleId, departmentId)` says so **as the caller** (403 `ROLE_NOT_ALLOWED`); the insert itself uses the secret key, so that call is the only rail. A caller scoped to departments must send one of theirs |
| `POST /admin/staff/:id/password` | Set a password; revokes that person's sessions. Allowed only if `can_manage_user(id)` (403 `NOT_AUTHORIZED`, the same answer for "no such user") |
| `GET /me` | The signed-in profile (no phone), the club's branding, `pages` (the About / Policies text an admin writes in the portal, `club_pages`), `location` (`{lat, lng, radiusM}` or null: the club's zone, `club_location`; the app keeps checklists shut outside it) and `access` (`my_access()`: the role with its names, scope, departments, permissions, assignable roles) |
| `GET /assignments` | The phone's offline set: the last 7 days (Cairo), every future date, open follow-ups. Items included, paged past PostgREST's 1000-row cap. |
| `GET /assignments/:id` | One round, if RLS lets you see it, plus signed links (1 h) for its photos and signature |
| `POST /assignments/:id/items/:itemId/answer` | `{answer?, note?}` → `mark_item_done` |
| `POST /assignments/:id/items/:itemId/photos` | Multipart `file` + `photoId` (uuid): a JPEG (≤ 5 MB) or an MP4 video from the camera (≤ 50 MB, checked by its `ftyp` bytes). The API stores it at `photos/{id}/{itemId}-{photoId}.jpg` or `.mp4`, then `attach_item_photo` |
| `POST /assignments/:id/submit` | Multipart `file` (PNG, ≤ 1 MB), `signatureId`, `completedAt` (ISO-8601 **with offset**), `note?` → `submit_assignment` |
| `PATCH /me/locale` | `set_locale`. (No password route: staff never change their password in the app; only an admin sets it, in the portal.) The language pushes are written in |
| `PUT /me/devices` | `{token, platform: android\|ios}` → `register_device_token`: the phone's FCM token now belongs to the caller (a shared phone changes hands) |
| `DELETE /me/devices/:token` | At sign-out → `unregister_device_token` (the caller's own token only) |
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

## Roles (migrations `20260929125516`, `…125625`, `…162634`)

- **Defaults, seeded to match the old four:** Admin (locked, whole club, everything except "Staff
  app"), Manager (team), Inspector (own), Cleaner (own, "Staff app" only). Clubs add their own in
  the portal's Roles screen (`create_role`, `update_role`, `delete_role`, `assign_role`).
- **Rails, inside those functions:** managing roles needs `roles.*` and whole-club scope; an editor
  cannot give a permission they lack (`staff_app.view` aside: it means "can be given checklists",
  a trait, not a power); a role with `users.create` / `users.edit` may create or assign exactly the
  roles ticked for it, even stronger ones (your decision, 29 Sep); nobody can assign the Admin role,
  edit it, or edit their own role; a role in use, or a default, cannot be deleted. Every change is in
  `role_audit`.
- **The Admin role is granted only by hand**, in the SQL Editor:
  `update profiles set role = 'admin' where id = '…';` (the trigger sets `role_id`).
- **Until flag day:** `profiles.role` stays as a mirror of the role's key (custom roles mirror as
  `cleaner`), `set_user_role(uuid, text)` stays as a wrapper, and `current_role()` stays for the
  unused legacy follow-up tables. The production portal on `main` and the old web checklist read
  them.
- **Other rules added on 29 Sep:** `reject_items` refuses a blank reason (`REASON_REQUIRED`);
  `set_club_location` works once, for the Admin role only. A wrong pin is cleared by support:
  `delete from public.club_location;`.

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

**`fcmServiceAccount`** (optional, per club): the club's Firebase service-account JSON, pasted whole as
an object (Firebase console → Project settings → Service accounts → Generate new private key). Absent:
no push for that club. The API checks its shape at boot and never prints it. Copy it into a local
`.env` with a script that writes the value without echoing it, and delete the downloaded file
afterwards; Firebase issues a new one whenever needed. Note that a local API with this key sends real
pushes from the club's live database. **On Railway:** read `CLUBS` with `railway variables --json`, add the
key to the club's entry, and write the whole JSON back with `railway variables --set-from-stdin CLUBS`, so
the key never lands on a command line; Railway redeploys and the log shows `push on for <slug>`.

**`mail`** (optional, per club): `{ tenantId, clientId, clientSecret, portalUrl }`, for the report emails.
Absent: no report emails for that club. The first three come from the club's Microsoft Entra app
registration (Entra admin centre → App registrations): tenantId is its Directory (tenant) ID, clientId
its Application (client) ID, clientSecret a client secret created under Certificates & secrets (copy the
secret's *Value* when it is made; it is shown once; secrets expire, so note the date). The app needs the
**application** permission `Mail.Send` (Microsoft Graph) with admin consent granted. `portalUrl` is the
base URL of the club's portal (the Railway portal's address), which the API calls to get the report. The
**sender address is not here**: an admin sets it on the portal's Club settings (it is stored in
`report_mail_settings.sender`) and it must be a real mailbox of that tenant. Recommended (IT): restrict the
app to that one mailbox, since `Mail.Send` as an application permission can otherwise send as anyone in the
tenant; create an Exchange application access policy
(`New-ApplicationAccessPolicy -AppId <clientId> -PolicyScopeGroupId <group with the mailbox> -AccessRight RestrictAccess`).
Mailbox restrictions can take about an hour to apply. One send is a single Graph request, so a PDF can be about
3 MB at most (real ones: 0.1 to 0.8 MB). `REPORT_MAIL_AT` (`HH:MM`, Cairo time, default `23:30`) moves the
send time; it is for testing only. Note that a local API with this key sends the club's real reports from its
live database (the claim stops a second API from sending the same one twice, but the first to claim wins, so
keep the local one stopped unless you are testing). **On Railway:** the same stdin recipe as the Firebase key:
read `CLUBS` with `railway variables --json`, add `mail` to the club's entry, write the whole JSON back with
`railway variables --set-from-stdin CLUBS`; Railway redeploys. Never put the secret on a command line.

**Cutover:** `select private.copy_auth_logins();` copies logins and password hashes from
`auth.users` again (newer hash wins). Run it right before the old portal and app are retired, so a
password changed there in the meantime is not lost.
