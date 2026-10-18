-- F-01 (qa/05-review-findings.md), story PLAT-01: evidence is private.
--
-- Live on 18 Oct: checklist-media was public = true and checklist_media_read
-- was SELECT TO public with a bucket-only check, so anyone could list and
-- download all 952 photos, videos and signatures without signing in.
--
-- Since Step 3 only the API touches storage: it uploads and signs links with
-- the secret key (service_role bypasses RLS), and the app and the portal
-- show evidence through those signed links. So no client policy is needed:
--   * checklist_media_read goes (anonymous list and download).
--   * checklist_media_upload goes too (any signed-in user could write
--     anywhere in the bucket; F-62). PLAN.md rule 3 / Step 4.
--
-- Breaks on purpose: the old web checklist, which uploaded and showed
-- evidence directly (decision LEGACY-Q1: accept nothing more from it).
-- Objects that were public may still be served from the CDN cache for up to
-- an hour after this runs.
--
-- Ownership: storage.objects and storage.buckets belong to
-- supabase_storage_admin, not postgres, but Supabase lets the migration role
-- drop policies there: applied through the MCP on 18 Oct without error. For
-- a new club, if it is ever refused ("must be owner of table objects"), do
-- the same in the dashboard: make the bucket private and delete both
-- policies. A private bucket alone is NOT enough: checklist_media_read TO
-- public would still let the anon key download through the storage API.
--
-- Applied to the live database on 18 Oct 2026 as version 20261018124834.
-- Verified: bucket private, no checklist_media_* policy, anonymous public
-- URL and download 400, anonymous list [].

begin;

update storage.buckets set public = false where id = 'checklist-media';

drop policy if exists checklist_media_read on storage.objects;
drop policy if exists checklist_media_upload on storage.objects;

commit;

-- Verification — expect each value shown:
--   select public from storage.buckets where id = 'checklist-media';            -- false
--   select count(*) from pg_policies
--    where schemaname = 'storage' and policyname like 'checklist_media_%';      -- 0
--   Anonymous: GET <url>/storage/v1/object/public/checklist-media/<a path>     -- 400/404, not the file
--   Anonymous: POST <url>/storage/v1/object/list/checklist-media               -- []
--   Portal: a checklist with photos shows them (signed links); the app the same.
