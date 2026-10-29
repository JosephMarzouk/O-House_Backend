import { Club } from '../clubs/clubs';
import { classify, Delivery, PushMessage } from './fcm';
import { pushData, render, RoundInfo, when } from './messages';
import { backoffMs, groupRows, NotificationsService, Row, settle, taskOf } from './notifications.module';

const NOW = new Date('2026-10-12T08:00:00Z'); // 11:00 in Cairo

const round: RoundInfo = {
  id: 'a1',
  title_en: 'Showers',
  title_ar: 'الدش',
  site_name_en: 'Pool building',
  site_name_ar: 'مبنى حمام السباحة',
  scheduled_date: '2026-10-13',
  window_start: '07:00:00',
  deadline: '2026-10-12T08:30:00Z',
};

const row = (over: Partial<Row>): Row => ({
  id: 1,
  recipient_id: 'u1',
  event: 'E1',
  assignment_id: 'a1',
  params: {},
  attempts: 1,
  created_at: NOW.toISOString(),
  ...over,
});

describe('messages', () => {
  it('says when, in Cairo time: today, tomorrow, else the date', () => {
    expect(when('en', '2026-10-12', '07:00:00', NOW)).toBe('today 07:00');
    expect(when('en', '2026-10-13', '07:00:00', NOW)).toBe('tomorrow 07:00');
    expect(when('ar', '2026-10-13', null, NOW)).toBe('غدًا');
    expect(when('en', '2026-10-16', '07:00:00', NOW)).toBe('Fri 16 Oct 07:00');
  });

  it('E1 names the round, place and time; several become one summary', () => {
    expect(render('E1', 'en', round, {}, 1, NOW)).toEqual({ title: 'New round', body: 'Showers · Pool building, tomorrow 07:00' });
    expect(render('E1', 'en', round, {}, 3, NOW).body).toBe('3 new rounds for you');
    expect(render('E1', 'ar', round, {}, 1, NOW).body).toBe('الدش · مبنى حمام السباحة، غدًا 07:00'); // Arabic comma
  });

  it('E3 gives the closing time in Cairo time', () => {
    expect(render('E3', 'en', round, {}, 1, NOW).body).toBe('Showers · Pool building closes at 11:30');
  });

  it('E5 counts the items and shortens a long reason', () => {
    expect(render('E5', 'en', round, { count: 2, reason: 'Streaks on the glass' }, 1, NOW).body).toBe(
      '2 items sent back: Showers · Pool building — Streaks on the glass',
    );
    const long = render('E5', 'en', round, { count: 1, reason: 'x'.repeat(300) }, 1, NOW).body;
    expect(long.length).toBeLessThan(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('falls back to the other language when one name is empty', () => {
    expect(render('E4', 'ar', { ...round, title_ar: null, site_name_ar: '' }, {}, 1, NOW).body).toContain('Showers · Pool building');
  });

  it('taps open the round, Home for a manager, Tasks for a summary', () => {
    expect(pushData('E3', 'a1', {}, 1)).toEqual({ event: 'E3', open: 'task', assignmentId: 'a1' });
    expect(pushData('E4', 'a1', { manager: true }, 1)).toEqual({ event: 'E4', open: 'home' });
    expect(pushData('E8', 'a1', {}, 1)).toEqual({ event: 'E8', open: 'home' });
    expect(pushData('E1', 'a1', {}, 2)).toEqual({ event: 'E1', open: 'tasks' });
  });
});

describe('grouping and outcomes', () => {
  it('one planner save is one push per person; other events stay one each', () => {
    const groups = groupRows([
      row({ id: 1, params: { txid: '9' } }),
      row({ id: 2, params: { txid: '9' }, assignment_id: 'a2' }),
      row({ id: 3, params: { txid: '9' }, recipient_id: 'u2' }),
      row({ id: 4, params: { txid: '10' } }),
      row({ id: 5, event: 'E3' }),
      row({ id: 6, event: 'E3' }),
    ]);
    expect(groups.map((g) => [g.ids, g.count])).toEqual([[[1, 2], 2], [[3], 1], [[4], 1], [[5], 1], [[6], 1]]);
  });

  it('sent if any device took it; skipped with no device; retried with backoff, then failed', () => {
    expect(settle(['dead', 'sent'], 1, NOW).status).toBe('sent');
    expect(settle([], 1, NOW)).toEqual({ status: 'skipped', last_error: 'no device' });
    expect(settle(['dead'], 1, NOW).status).toBe('skipped');
    expect(settle(['retry'], 2, NOW)).toEqual({
      status: 'queued',
      last_error: 'FCM unavailable',
      available_at: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(settle(['retry'], 5, NOW).status).toBe('failed');
    expect(settle(['error'], 1, NOW).status).toBe('failed');
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
  });

  it('only an unregistered or invalid token is dead', () => {
    expect(classify('messaging/registration-token-not-registered')).toBe('dead');
    expect(classify('messaging/mismatched-credential')).toBe('error');
    expect(classify('messaging/internal-error')).toBe('retry');
    expect(classify(undefined)).toBe('retry');
  });
});

/** Just enough of supabase-js: rpc(), and from().select/update/delete().in(). */
function fakeDb(data: Record<string, unknown>) {
  const writes: { table: string; op: string; value?: unknown; ids: unknown[] }[] = [];
  const db = {
    writes,
    rpc: async (name: string) => ({ data: data[name], error: null }),
    from(table: string) {
      let op = 'select';
      let value: unknown;
      const q = {
        select: () => q,
        update: (v: unknown) => ((op = 'update'), (value = v), q),
        delete: () => ((op = 'delete'), q),
        in: (_col: string, ids: unknown[]) => {
          if (op !== 'select') writes.push({ table, op, value, ids });
          return Promise.resolve({ data: op === 'select' ? data[table] : null, error: null });
        },
      };
      return q;
    },
  };
  return db;
}

describe('NotificationsService.work', () => {
  const club = { slug: 'ohouse' } as Club;

  function service(db: ReturnType<typeof fakeDb>, send: (m: PushMessage[]) => Delivery[]) {
    const sent: PushMessage[] = [];
    const svc = new NotificationsService(
      { all: () => [] } as never,
      { for: () => db } as never,
      async (_c, messages) => (sent.push(...messages), send(messages)),
    );
    return { svc, sent };
  }

  it('renders in the recipient language, sends to each device, writes the outcome back and drops dead tokens', async () => {
    const db = fakeDb({
      claim_notifications: [row({ id: 7, event: 'E3' })],
      assignments_v: [round],
      profiles: [{ id: 'u1', locale: 'en' }],
      device_tokens: [
        { user_id: 'u1', fcm_token: 't-live' },
        { user_id: 'u1', fcm_token: 't-dead' },
      ],
    });
    const { svc, sent } = service(db, (m) => m.map((x) => (x.token === 't-dead' ? 'dead' : 'sent')));
    await svc.work(club, NOW);

    expect(sent.map((m) => m.token)).toEqual(['t-live', 't-dead']);
    expect(sent[0]).toMatchObject({ title: 'Due soon', data: { event: 'E3', open: 'task', assignmentId: 'a1' } });
    expect(db.writes).toContainEqual({
      table: 'notifications',
      op: 'update',
      value: { status: 'sent', last_error: null, sent_at: NOW.toISOString(), title: 'Due soon', body: 'Showers · Pool building closes at 11:30' },
      ids: [7],
    });
    expect(db.writes).toContainEqual({ table: 'device_tokens', op: 'delete', value: undefined, ids: ['t-dead'] });
  });

  it('a stale row or a person without a phone sends nothing; an FCM outage is retried', async () => {
    const old = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const db = fakeDb({
      claim_notifications: [row({ id: 1, event: 'E4', created_at: old }), row({ id: 2, event: 'E4', recipient_id: 'nobody' }), row({ id: 3, event: 'E4' })],
      assignments_v: [round],
      profiles: [],
      device_tokens: [{ user_id: 'u1', fcm_token: 't1' }],
    });
    const svc = new NotificationsService({ all: () => [] } as never, { for: () => db } as never, async () => {
      throw new Error('ECONNRESET');
    });
    await svc.work(club, NOW);

    const status = Object.fromEntries(db.writes.map((w) => [String(w.ids[0]), (w.value as { status: string }).status]));
    expect(status).toEqual({ '1': 'skipped', '2': 'skipped', '3': 'queued' });
    // No profile locale: the club default, Arabic.
    expect((db.writes.find((w) => w.ids[0] === 3)!.value as { title: string }).title).toBe('تأخرت الجولة');
  });
});

describe('E1 for a multi-place task (QG): one push per task, opening it', () => {
  const place = (id: string, group: string | null): RoundInfo => ({
    ...round,
    id,
    group_id: group,
    group_title_en: group ? 'Morning zone' : null,
    group_title_ar: group ? 'المنطقة الصباحية' : null,
  });
  const byId = (...rs: RoundInfo[]) => new Map(rs.map((r) => [r.id, r]));
  const e1 = (id: number, a: string, over: Partial<Row> = {}) => row({ id, assignment_id: a, params: { txid: '9' }, ...over });

  it('names the task and counts its places, in both languages', () => {
    const r = place('a1', 'g1');
    expect(render('E1', 'en', r, {}, 3, NOW, true)).toEqual({ title: 'New task', body: 'Morning zone (3 places)' });
    expect(render('E1', 'ar', r, {}, 3, NOW, true)).toEqual({ title: 'مهمة جديدة', body: 'المنطقة الصباحية (3 أماكن)' });
    expect(render('E1', 'ar', r, {}, 2, NOW, true).body).toBe('المنطقة الصباحية (مكانان)');
    expect(pushData('E1', 'a1', {}, 3, 'g1')).toEqual({ event: 'E1', open: 'group', groupId: 'g1' });
  });

  it('a save whose rounds all share one task is that task; anything else keeps today’s push', () => {
    const [g] = groupRows([e1(1, 'a1'), e1(2, 'a2'), e1(3, 'a3')]);
    expect(taskOf(g, byId(place('a1', 'g1'), place('a2', 'g1'), place('a3', 'g1')))).toBe('g1');
    // two tasks (a week of the planner) or a task plus a lone checklist: one summary, as before
    expect(taskOf(g, byId(place('a1', 'g1'), place('a2', 'g1'), place('a3', 'g2')))).toBeNull();
    expect(taskOf(g, byId(place('a1', 'g1'), place('a2', 'g1'), place('a3', null)))).toBeNull();
    // a single checklist, even one place of a task: its own push
    const [one] = groupRows([e1(4, 'a1')]);
    expect(taskOf(one, byId(place('a1', 'g1')))).toBeNull();
    // other events never
    const [e3] = groupRows([row({ id: 5, event: 'E3' })]);
    expect(taskOf(e3, byId(place('a1', 'g1')))).toBeNull();
  });

  it('the worker sends one push for the task and writes it on every row', async () => {
    const db = fakeDb({
      claim_notifications: [e1(1, 'a1'), e1(2, 'a2'), e1(3, 'a3'), row({ id: 4, assignment_id: 'b1', params: { txid: '10' } })],
      assignments_v: [place('a1', 'g1'), place('a2', 'g1'), place('a3', 'g1'), place('b1', null)],
      profiles: [{ id: 'u1', locale: 'en' }],
      device_tokens: [{ user_id: 'u1', fcm_token: 't1' }],
    });
    const { svc, sent } = service(db, (m) => m.map(() => 'sent'));
    await svc.work(club, NOW);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ title: 'New task', body: 'Morning zone (3 places)', data: { event: 'E1', open: 'group', groupId: 'g1' } });
    // the lone checklist is untouched
    expect(sent[1]).toMatchObject({ title: 'New round', data: { event: 'E1', open: 'task', assignmentId: 'b1' } });
    expect(db.writes.find((w) => w.table === 'notifications' && w.ids.length === 3)?.ids).toEqual([1, 2, 3]);
  });

  const club = { slug: 'ohouse' } as Club;
  function service(db: ReturnType<typeof fakeDb>, send: (m: PushMessage[]) => Delivery[]) {
    const sent: PushMessage[] = [];
    const svc = new NotificationsService(
      { all: () => [] } as never,
      { for: () => db } as never,
      async (_c, messages) => (sent.push(...messages), send(messages)),
    );
    return { svc, sent };
  }
});
