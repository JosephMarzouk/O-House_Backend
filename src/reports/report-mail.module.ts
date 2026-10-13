import { Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Club } from '../clubs/clubs';
import { ClubsService } from '../clubs/clubs.module';
import { must } from '../common/upstream';
import { AuthModule } from '../auth/auth.module';
import { TokenService } from '../auth/tokens';
import { SystemClients } from '../notifications/notifications.module';
import { graphSend } from './graph';

/**
 * The report emails. Per club with `mail` in CLUBS, every minute:
 *   due?   report_mail_settings.frequency and the Cairo clock (duePeriod)
 *   claim  claim_report_mail(start, end): a row per department with
 *          recipients, once across every API instance on this database
 *   send   the portal's own PDF (reports/daily/pdf), rendered signed in as
 *          the admin who saved the settings, mailed through Microsoft Graph
 *          from the club's sender address, whoever saved them: Club
 *          settings' "Send from", else CLUBS.<slug>.mail.sender. Each club
 *          uses only its own database, app and portal, so one API can serve
 *          every club (parseClubs refuses a shared portal or sender)
 *   log    report_mail_log: sent, or failed with the reason (Club settings
 *          shows it). A failure is claimed again 5 minutes later, 3 tries.
 *
 * The PDF comes from the portal so there is one report and one Chrome; the
 * saver's own token means an emailed report never shows more than they see.
 */

const TZ = 'Africa/Cairo';
/** The send time, Cairo. A knob for testing without waiting for 23:30. */
const SEND_AT = process.env.REPORT_MAIL_AT ?? '23:30';

export type Frequency = 'off' | 'daily' | 'weekly';

/** A department's send, or the "all departments" one (no id, no names). */
interface Claimed {
  department_id: string | null;
  name_en: string | null;
  name_ar: string | null;
  recipients: string[];
  set_by: string | null;
}

const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The period whose report is due at `now`, or null. Daily: today, from
 * `at` to midnight. Weekly: Saturday to Friday, on Friday from `at`. Egypt's
 * week, as the planner's (o-house-admin lib/format.ts weekStart).
 */
export function duePeriod(now: Date, frequency: string, at = '23:30'): [string, string] | null {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  if (`${p.hour}:${p.minute}` < at) return null;
  const today = `${p.year}-${p.month}-${p.day}`;
  if (frequency === 'daily') return [today, today];
  if (frequency === 'weekly' && p.weekday === 'Fri') return [addDays(today, -6), today];
  return null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (ymd: string, locale: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * The portal's summary of the same rows as the PDF (reports/daily/summary):
 * the email's few lines. Status names arrive in both languages.
 */
export interface ReportSummary {
  total: number;
  byStatus: { n: number; en: string; ar: string }[];
  doneBy: { name: string; n: number }[];
  notDoneBy: string[];
}

/**
 * Subject and body, English then Arabic: the recipients may read either. The
 * body is a brief (how many, by status, who did them, whose are not done);
 * every answer, photo and signature is in the PDF. No department name: the
 * "all departments" email.
 */
export function mailText(
  club: Club,
  dept: { name_en: string | null; name_ar: string | null },
  [from, to]: [string, string],
  s: ReportSummary,
) {
  const weekly = from !== to;
  const en = weekly ? `${fmt(from, 'en-GB')} – ${fmt(to, 'en-GB')}` : fmt(from, 'en-GB');
  const ar = weekly ? `${fmt(from, 'ar-EG')} – ${fmt(to, 'ar-EG')}` : fmt(from, 'ar-EG');
  const deptEn = dept.name_en?.trim() || 'All departments';
  const deptAr = dept.name_en ? (dept.name_ar || dept.name_en).trim() : 'كل الأقسام';
  const n = (v: number) => v.toLocaleString('ar-EG');
  const line = (label: string, value: string) => `<p style="margin:4px 0"><b>${label}</b> ${value}</p>`;

  const english = s.total
    ? line(`${s.total} checklist${s.total === 1 ? '' : 's'}:`, esc(s.byStatus.map((b) => `${b.n} ${b.en}`).join(' · '))) +
      (s.doneBy.length ? line('Done by:', esc(s.doneBy.map((d) => `${d.name} (${d.n})`).join(', '))) : '') +
      (s.notDoneBy.length ? line('Not done:', esc(s.notDoneBy.join(', '))) : '') +
      '<p style="margin:12px 0 0">The full details (every answer, photo and signature) are in the attached PDF.</p>'
    : '<p>No checklists in this period.</p>';
  const arabic = s.total
    ? line(`${n(s.total)} قائمة تحقق:`, esc(s.byStatus.map((b) => `${n(b.n)} ${b.ar}`).join(' · '))) +
      (s.doneBy.length ? line('أنجزها:', esc(s.doneBy.map((d) => `${d.name} (${n(d.n)})`).join('، '))) : '') +
      (s.notDoneBy.length ? line('لم تُنجز:', esc(s.notDoneBy.join('، '))) : '') +
      '<p style="margin:12px 0 0">التفاصيل الكاملة (كل الإجابات والصور والتوقيعات) في ملف PDF المرفق.</p>'
    : '<p>لا توجد قوائم تحقق في هذه الفترة.</p>';

  return {
    subject: `${club.name.en} · ${deptEn} · ${weekly ? 'weekly' : 'daily'} report · ${en}`,
    html:
      '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1d2a3a">' +
      `<p style="font-size:16px"><b>${weekly ? 'Weekly' : 'Daily'} report · ${esc(deptEn)} · ${esc(en)}</b></p>` +
      english +
      '<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">' +
      `<div dir="rtl"><p style="font-size:16px"><b>التقرير ${weekly ? 'الأسبوعي' : 'اليومي'} · ${esc(deptAr)} · ${esc(ar)}</b></p>` +
      arabic +
      '</div>' +
      `<p style="color:#888;margin-top:16px">${esc(club.name.en)}</p>` +
      '</div>',
  };
}

/**
 * One report email: the portal's summary and PDF, both fetched signed in as
 * `accessToken`'s person (the admin who saved the settings), then mailed
 * through Microsoft Graph from `sender`. Throws a reason fit for Club settings.
 */
export async function sendReport(
  club: Club,
  sender: string,
  accessToken: string,
  r: Pick<Claimed, 'department_id' | 'name_en' | 'name_ar' | 'recipients'>,
  [from, to]: [string, string],
) {
  const query = `date=${from}${to !== from ? `&to=${to}` : ''}&dept=${r.department_id ?? 'all'}`;
  const get = (path: string) =>
    fetch(`${club.mail!.portalUrl}/reports/daily/${path}?${query}`, {
      headers: { Cookie: `oh_at=${accessToken}` },
      redirect: 'manual', // a redirect is the sign-in page, never a report
      signal: AbortSignal.timeout(120_000),
    });

  const sum = await get('summary');
  if (sum.status === 403) throw new Error('the person who saved the settings can no longer see reports');
  if (!sum.ok || !sum.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`the portal could not make the summary (${sum.status})`);
  }
  const summary = (await sum.json()) as ReportSummary;

  const res = await get('pdf');
  if (!res.ok || !res.headers.get('content-type')?.includes('application/pdf')) {
    throw new Error(`the portal could not make the PDF (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `report-${from}.pdf`;
  await graphSend(club.mail!, sender, {
    to: r.recipients,
    ...mailText(club, r, [from, to], summary),
    attachment: { name, bytes: Buffer.from(await res.arrayBuffer()) },
  });
}

@Injectable()
export class ReportMailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('ReportMail');
  private timer?: NodeJS.Timeout;
  private readonly busy = new Set<string>();

  constructor(
    private readonly clubs: ClubsService,
    private readonly system: SystemClients,
    private readonly tokens: TokenService,
  ) {}

  onApplicationBootstrap() {
    const clubs = this.clubs.all().filter((c) => c.mail);
    if (clubs.length === 0) return;
    this.timer = setInterval(() => clubs.forEach((c) => this.once(c.slug, () => this.tick(c))), 60_000);
    this.log.log(`report emails on for ${clubs.map((c) => c.slug).join(', ')} at ${SEND_AT} Cairo`);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private once(key: string, run: () => Promise<void>) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    run()
      .catch((e) => this.log.warn(`[${key}] ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.busy.delete(key));
  }

  async tick(club: Club, now = new Date()) {
    const db = this.system.for(club);
    const settings = must(await db.from('report_mail_settings').select('frequency, sender').maybeSingle()) as {
      frequency: Frequency;
      sender: string | null;
    } | null;
    const period = duePeriod(now, settings?.frequency ?? 'off', SEND_AT);
    if (!period) return;

    const rows = (must(await db.rpc('claim_report_mail', { p_start: period[0], p_end: period[1] })) ?? []) as Claimed[];
    for (const r of rows) {
      // Club settings' "Send from" first, then this club's own CLUBS default.
      const outcome = await this.sendOne(club, settings?.sender || club.mail!.sender, r, period).then(
        () => ({ status: 'sent', error: null }),
        (e: unknown) => ({ status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }),
      );
      if (outcome.error) {
        this.log.warn(`[${club.slug}] ${r.name_en?.trim() ?? 'all departments'} ${period.join('..')}: ${outcome.error}`);
      }
      const row = db
        .from('report_mail_log')
        .update({ ...outcome, updated_at: new Date().toISOString() })
        .eq('period_start', period[0])
        .eq('period_end', period[1]);
      must(await (r.department_id ? row.eq('department_id', r.department_id) : row.is('department_id', null)));
    }
  }

  private async sendOne(club: Club, sender: string | null, r: Claimed, period: [string, string]) {
    if (!sender) throw new Error('no sender address: set "Send from" on Club settings, or mail.sender for this club in CLUBS');
    if (!r.set_by) throw new Error('nobody has saved the report settings');
    await sendReport(club, sender, this.tokens.accessToken(club, r.set_by), r, period);
  }
}

@Module({
  imports: [AuthModule],
  providers: [SystemClients, ReportMailService],
})
export class ReportMailModule {}
