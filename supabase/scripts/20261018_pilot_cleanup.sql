-- DATA-01, pilot version (decision 18 Oct): delete the dummy checklists from
-- the live O House database before the 2-week pilot, keeping a small example
-- of each thing. NOT a migration: run once, by hand, after a backup.
--
-- Kept:
--   * every place, department, round template, role, permission, club
--     setting, club page, report-mail setting and recipient (the set-up);
--   * every person and their sign-in (test accounts included: they can't be
--     deleted while they own a kept example, and Deactivate comes after the
--     pilot);
--   * one example checklist per status: the newest approved, expired,
--     follow_up and submitted one made in the new app; plus the one planned
--     round and its checklists, so the planner shows an example too;
--   * report_mail_log (2 rows) and device_tokens (a real phone).
-- Deleted:
--   * every other checklist: the 425 undated ones from the old web checklist
--     and the other new-app ones, with their items, status history and
--     notifications (all ON DELETE CASCADE);
--   * every notification (push history of dummy work).
-- Not touched: the photos and signatures in the (now private) bucket. Supabase
-- refuses SQL deletes from storage; the orphans are unreachable and can be
-- emptied later from the dashboard. Legacy tables go with LEGACY-02.
--
-- One transaction: any error and nothing changes. Prints what it removed.
--
-- RUN on the live database 18 Oct 2026 (approved), with every removed row
-- first copied to private.pilot_backup_{submissions, assignment_items,
-- submission_events, notifications}. Removed 442 checklists, 27 items, 655
-- events, 11 notifications; left 6 checklists (approved 1, expired 3,
-- follow_up 1, submitted 1). Drop the backup tables once the pilot is over.

begin;

create temp table _keep on commit drop as
  (select distinct on (effective_status) id
     from public.assignments_v
    where scheduled_date is not null
    order by effective_status, scheduled_date desc, id)
  union
  (select s.id from public.submissions s where s.round_id in (select id from public.rounds));

create temp table _counts on commit drop as select
  (select count(*) from public.submissions where id not in (select id from _keep))                  as checklists,
  (select count(*) from public.assignment_items where assignment_id not in (select id from _keep))  as items,
  (select count(*) from public.submission_events where submission_id not in (select id from _keep)) as events,
  (select count(*) from public.notifications)                                                       as notifications,
  (select count(*) from _keep)                                                                      as kept;

delete from public.notifications;
delete from public.submissions where id not in (select id from _keep);

select * from _counts;

commit;

-- After: select effective_status, count(*) from assignments_v group by 1;
--   → about 6 rows (one per status, plus the round's).
