/**
 * What a push says, in the recipient's language (PN-6). PN-8: nothing beyond
 * the round's title, place and time (and, for a send-back, the reviewer's
 * reason, which is about the work, not a person).
 *
 * Times are Cairo time, like assignments_v's deadline.
 */
export type Event = 'E1' | 'E3' | 'E4' | 'E5' | 'E8';
export type Locale = 'en' | 'ar';

/** The assignments_v columns a message needs. */
export interface RoundInfo {
  id: string;
  title_en: string | null;
  title_ar: string | null;
  site_name_en: string | null;
  site_name_ar: string | null;
  scheduled_date: string | null; // YYYY-MM-DD
  window_start: string | null; // HH:MM:SS
  deadline: string | null; // timestamptz
  // The multi-place task it belongs to (a zone round or a one-off task), if any.
  group_id?: string | null;
  group_title_en?: string | null;
  group_title_ar?: string | null;
}

export interface Params {
  txid?: string;
  count?: number;
  reason?: string | null;
  manager?: boolean;
}

const TZ = 'Africa/Cairo';
const REASON_MAX = 100;

const pick = (locale: Locale, en: string | null, ar: string | null) =>
  (locale === 'ar' ? ar || en : en || ar) || '';

/** "Showers · Main building", or whichever of the two exists. */
function roundName(locale: Locale, r: RoundInfo): string {
  const title = pick(locale, r.title_en, r.title_ar);
  const site = pick(locale, r.site_name_en, r.site_name_ar);
  return title && site && title !== site ? `${title} · ${site}` : title || site;
}

const intlLocale = (l: Locale) => (l === 'ar' ? 'ar-EG' : 'en-GB');

function clock(locale: Locale, at: Date): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

const cairoDate = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at); // YYYY-MM-DD

/** "today 07:00", "tomorrow 07:00", or "Thu 16 Oct 07:00". */
export function when(locale: Locale, date: string, time: string | null, now: Date): string {
  const today = cairoDate(now);
  const tomorrow = cairoDate(new Date(now.getTime() + 86_400_000));
  // Noon UTC is the same calendar day in Cairo, so the date never shifts.
  const day =
    date === today
      ? locale === 'ar' ? 'اليوم' : 'today'
      : date === tomorrow
        ? locale === 'ar' ? 'غدًا' : 'tomorrow'
        : new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(
            new Date(`${date}T12:00:00Z`),
          );
  return time ? `${day} ${time.slice(0, 5)}` : day;
}

const COPY = {
  en: {
    E1: 'New round',
    E1many: 'New rounds',
    E1task: 'New task',
    places: (n: number) => `${n} places`,
    E3: 'Due soon',
    E4: 'Overdue',
    E5: 'Sent back',
    E8: 'Follow-up raised',
    comma: ', ',
    many: (n: number) => `${n} new rounds for you`,
    closes: (name: string, t: string) => `${name} closes at ${t}`,
    late: (name: string) => `${name} was not submitted in time`,
    sentBack: (n: number, name: string) => `${n} ${n === 1 ? 'item' : 'items'} sent back: ${name}`,
    followUp: (name: string) => `${name} needs a follow-up`,
  },
  ar: {
    E1: 'جولة جديدة',
    E1many: 'جولات جديدة',
    E1task: 'مهمة جديدة',
    // Arabic counts: 2 is the dual, 3–10 a plural, 11+ a singular accusative.
    places: (n: number) => (n === 2 ? 'مكانان' : n <= 10 ? `${n} أماكن` : `${n} مكانًا`),
    E3: 'اقترب موعد الإغلاق',
    E4: 'تأخرت الجولة',
    E5: 'أُعيدت للتعديل',
    E8: 'مطلوب متابعة',
    comma: '، ',
    many: (n: number) => `لديك ${n} جولات جديدة`,
    closes: (name: string, t: string) => `${name} تُغلق الساعة ${t}`,
    late: (name: string) => `${name} لم تُرسل في الموعد`,
    sentBack: (n: number, name: string) => `أُعيد ${n} من البنود: ${name}`,
    followUp: (name: string) => `${name} تحتاج إلى متابعة`,
  },
} as const;

/**
 * One push's title and body. `count` > 1 only for E1, when one planner save
 * gave the same person several rounds (one summary, not a burst). `task`:
 * those rounds are the places of one multi-place task (QG), so the push
 * names the task: "New task: Morning zone (3 places)".
 */
export function render(
  event: Event,
  locale: Locale,
  round: RoundInfo | null,
  params: Params,
  count: number,
  now: Date,
  task = false,
): { title: string; body: string } {
  const c = COPY[locale];
  const name = round ? roundName(locale, round) : '';
  switch (event) {
    case 'E1':
      if (task && round) {
        const title = pick(locale, round.group_title_en ?? null, round.group_title_ar ?? null) || name;
        return { title: c.E1task, body: `${title} (${c.places(count)})` };
      }
      if (count > 1 || !round) return { title: c.E1many, body: c.many(count) };
      return {
        title: c.E1,
        body: round.scheduled_date ? `${name}${c.comma}${when(locale, round.scheduled_date, round.window_start, now)}` : name,
      };
    case 'E3':
      return { title: c.E3, body: round?.deadline ? c.closes(name, clock(locale, new Date(round.deadline))) : name };
    case 'E4':
      return { title: c.E4, body: c.late(name) };
    case 'E5': {
      const reason = (params.reason ?? '').trim();
      const short = reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
      const body = c.sentBack(Math.max(1, params.count ?? 1), name);
      return { title: c.E5, body: short ? `${body} — ${short}` : body };
    }
    case 'E8':
      return { title: c.E8, body: c.followUp(name) };
  }
}

/**
 * The tap target (PN-7). Staff open the round; a manager's copy (E4's
 * second one, E8) opens Home, since the round isn't in a manager's own list;
 * several new rounds open the Tasks tab, and one multi-place task its task
 * screen (`groupId`; an app build before QR places ignores it and opens).
 */
export function pushData(
  event: Event,
  assignmentId: string | null,
  params: Params,
  count: number,
  groupId: string | null = null,
): Record<string, string> {
  if (event === 'E1' && groupId) return { event, open: 'group', groupId };
  const open = event === 'E8' || params.manager ? 'home' : event === 'E1' && count > 1 ? 'tasks' : 'task';
  return { event, open, ...(open === 'task' && assignmentId ? { assignmentId } : {}) };
}
