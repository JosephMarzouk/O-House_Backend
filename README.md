# o-house-api

The O House backend (NestJS, from plan Step 1), and the **only** home for database migrations.

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
