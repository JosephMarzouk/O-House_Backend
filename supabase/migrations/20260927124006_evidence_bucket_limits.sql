-- =====================================================================
-- Evidence bucket limits, for video evidence (camera clips, MP4).
--
-- Storage refuses anything else at the door. 50 MB is Supabase's default
-- project-wide upload limit, so a larger bucket limit would not take effect;
-- the API holds photos to 5 MB and clips to the same 50 MB. The live bucket
-- held only image/jpeg (≤ 6 MB) and image/png when this was applied.
-- =====================================================================

update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4']
 where id = 'checklist-media';
