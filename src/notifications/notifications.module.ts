import { Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Club } from '../clubs/clubs';
import { ClubsService } from '../clubs/clubs.module';
import { must } from '../common/upstream';
import { Delivery, fcmSend, PushMessage, Sender } from './fcm';
import { Event, Locale, Params, pushData, render, RoundInfo } from './messages';

/**
 * The push worker (plan Step 5). Per club with a Firebase key:
 *   every minute  enqueue_due_notifications()  E3 / E4 from the deadlines
 *   every 5 s     claim_notifications(100)     → render → FCM → write back
 * The database triggers enqueue E1, E5 and E8 themselves. The queue table is
 * the history: each row keeps the title and body it was sent with (PN-3).
 *
 * ponytail: two setIntervals, not @nestjs/schedule (v12 is ESM-only, and two
 * timers don't need a library). Several API instances are safe: the claim
 * uses SKIP LOCKED and enqueueing is deduped by key.
 */

/**
 * The secret key's third home (with media/ and auth/): a provider of the
 * worker modules (this one and reports/), never exported from a module, so
 * no request handler can inject it.
 */
@Injectable()
export class SystemClients {
  private readonly clients = new Map<string, SupabaseClient>();

  for(club: Club): SupabaseClient {
    let c = this.clients.get(club.slug);
    if (!c) {
      c = createClient(club.supabaseUrl, club.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      this.clients.set(club.slug, c);
    }
    return c;
  }
}

export const SENDER = Symbol('SENDER');

export interface Row {
  id: number;
  recipient_id: string;
  event: Event;
  assignment_id: string | null;
  params: Params | null;
  attempts: number;
  created_at: string;
}

/** One push to one person: a single row, or an E1 planner save's rows for that person. */
export interface Group {
  ids: number[];
  recipient: string;
  event: Event;
  assignmentId: string | null;
  params: Params;
  attempts: number;
  createdAt: string;
  count: number;
}

export interface Outcome {
  status: 'sent' | 'queued' | 'failed' | 'skipped';
  last_error: string | null;
  sent_at?: string;
  available_at?: string;
}

const CLAIM = 100; // keeps the follow-up `in (...)` lists well inside a URL
const MAX_ATTEMPTS = 5; // claim_notifications stops re-claiming at 5 too
const STALE_MS = 60 * 60_000;
const DEFAULT_LOCALE: Locale = 'ar'; // the club's staff; profiles.locale is null until someone picks one
const ROUND_COLUMNS = 'id, title_en, title_ar, site_name_en, site_name_ar, scheduled_date, window_start, deadline';

/** E1 rows from one transaction (a planner save) become one summary per person; the rest stay one each. */
export function groupRows(rows: Row[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const params = r.params ?? {};
    const key = r.event === 'E1' && params.txid ? `E1:${r.recipient_id}:${params.txid}` : `#${r.id}`;
    const g = groups.get(key);
    if (g) {
      g.ids.push(r.id);
      g.count += 1;
      g.attempts = Math.max(g.attempts, r.attempts);
    } else {
      groups.set(key, {
        ids: [r.id],
        recipient: r.recipient_id,
        event: r.event,
        assignmentId: r.assignment_id,
        params,
        attempts: r.attempts,
        createdAt: r.created_at,
        count: 1,
      });
    }
  }
  return [...groups.values()];
}

/** 30 s, 1, 2, 4 min. `attempts` already counts this claim. */
export const backoffMs = (attempts: number) => 30_000 * 2 ** Math.max(0, attempts - 1);

/** What one group's deliveries (one per device) mean for its rows. */
export function settle(deliveries: Delivery[], attempts: number, now: Date): Outcome {
  if (deliveries.length === 0) return { status: 'skipped', last_error: 'no device' };
  if (deliveries.includes('sent')) return { status: 'sent', last_error: null, sent_at: now.toISOString() };
  if (deliveries.every((d) => d === 'dead')) return { status: 'skipped', last_error: 'no live device' };
  if (deliveries.includes('retry') && attempts < MAX_ATTEMPTS) {
    return { status: 'queued', last_error: 'FCM unavailable', available_at: new Date(now.getTime() + backoffMs(attempts)).toISOString() };
  }
  return { status: 'failed', last_error: deliveries.includes('error') ? 'FCM refused the message' : 'FCM unavailable' };
}

@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Notifications');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<string>();

  constructor(
    private readonly clubs: ClubsService,
    private readonly system: SystemClients,
    @Inject(SENDER) private readonly send: Sender,
  ) {}

  onApplicationBootstrap() {
    const clubs = this.clubs.all().filter((c) => c.fcmServiceAccount);
    if (clubs.length === 0) return;
    this.timers.push(setInterval(() => clubs.forEach((c) => this.once(`due:${c.slug}`, () => this.enqueueDue(c))), 60_000));
    this.timers.push(setInterval(() => clubs.forEach((c) => this.once(`work:${c.slug}`, () => this.work(c))), 5_000));
    this.log.log(`push on for ${clubs.map((c) => c.slug).join(', ')}`);
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** A slow run is never overlapped by the next tick; a failure is a log line, and the next tick tries again. */
  private once(key: string, run: () => Promise<void>) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    run()
      .catch((e) => this.log.warn(`[${key}] ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.busy.delete(key));
  }

  async enqueueDue(club: Club) {
    must(await this.system.for(club).rpc('enqueue_due_notifications'));
  }

  async work(club: Club, now = new Date()) {
    const db = this.system.for(club);
    const rows = (must(await db.rpc('claim_notifications', { p_limit: CLAIM })) ?? []) as Row[];
    if (rows.length === 0) return;

    const groups = groupRows(rows);
    const recipients = [...new Set(groups.map((g) => g.recipient))];
    const roundIds = [...new Set(groups.map((g) => g.assignmentId).filter((id): id is string => !!id))];
    const [rounds, profiles, tokens] = await Promise.all([
      roundIds.length
        ? db.from('assignments_v').select(ROUND_COLUMNS).in('id', roundIds).then(must)
        : Promise.resolve([]),
      db.from('profiles').select('id, locale').in('id', recipients).then(must),
      db.from('device_tokens').select('user_id, fcm_token').in('user_id', recipients).then(must),
    ]);
    const roundById = new Map((rounds as RoundInfo[]).map((r) => [r.id, r]));
    const localeOf = new Map((profiles as { id: string; locale: string | null }[]).map((p) => [p.id, p.locale]));
    const tokensOf = new Map<string, string[]>();
    for (const t of tokens as { user_id: string; fcm_token: string }[]) {
      tokensOf.set(t.user_id, [...(tokensOf.get(t.user_id) ?? []), t.fcm_token]);
    }

    // Render each group and lay its messages out in one list for FCM.
    const plans = groups.map((g) => {
      const stale = now.getTime() - new Date(g.createdAt).getTime() > STALE_MS;
      const round = g.assignmentId ? (roundById.get(g.assignmentId) ?? null) : null;
      const locale: Locale = localeOf.get(g.recipient) === 'en' ? 'en' : localeOf.get(g.recipient) === 'ar' ? 'ar' : DEFAULT_LOCALE;
      const text = render(g.event, locale, round, g.params, g.count, now);
      const data = pushData(g.event, g.assignmentId, g.params, g.count);
      // A row queued over an hour ago (the worker was off) is old news.
      const devices = stale || (g.assignmentId && !round) ? [] : (tokensOf.get(g.recipient) ?? []);
      return { g, text, stale, messages: devices.map((token): PushMessage => ({ token, ...text, data })) };
    });

    const all = plans.flatMap((p) => p.messages);
    let deliveries: Delivery[];
    try {
      deliveries = all.length ? await this.send(club, all) : [];
    } catch (e) {
      this.log.warn(`[${club.slug}] FCM: ${e instanceof Error ? e.message : String(e)}`);
      deliveries = all.map(() => 'retry');
    }

    const dead: string[] = [];
    let at = 0;
    const writes = plans.map((p) => {
      const mine = deliveries.slice(at, at + p.messages.length);
      p.messages.forEach((m, i) => mine[i] === 'dead' && dead.push(m.token));
      at += p.messages.length;
      const outcome = p.stale ? { status: 'skipped', last_error: 'stale' } : settle(mine, p.g.attempts, now);
      return db
        .from('notifications')
        .update({ ...outcome, title: p.text.title, body: p.text.body })
        .in('id', p.g.ids)
        .then(must);
    });
    if (dead.length) writes.push(db.from('device_tokens').delete().in('fcm_token', dead).then(must));
    await Promise.all(writes);
  }
}

@Module({
  providers: [SystemClients, NotificationsService, { provide: SENDER, useValue: fcmSend }],
})
export class NotificationsModule {}
