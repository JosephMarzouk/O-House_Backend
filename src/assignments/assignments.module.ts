import { Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.module';
import { MediaModule, MediaService, toBucketPath } from '../media/media.module';
import { CurrentUser, User } from '../auth/current-user';
import { must } from '../common/upstream';

type Row = Record<string, unknown> & { id: string };
type Item = Row & { assignment_id: string; photo_paths: string[] | null };

const PAGE = 1000; // PostgREST's default max-rows: past it a response is cut SILENTLY
const IDS_PER_REQUEST = 50;

/** yyyy-MM-dd in Cairo, `days` from today. The app's window was device-local; Cairo is what the club means. */
export function cairoDate(days: number, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now + days * 86_400_000));
}

/** Reads every page, so a long list can never lose rows to the row cap. */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = must(await page(from, from + PAGE - 1)) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly media: MediaService,
  ) {}

  /**
   * The phone's offline set, the same window as today's app: the last 7 days,
   * every future date (so tomorrow's round is cached the night before), and
   * any open follow-up whatever its date. Paths only; links come from get().
   */
  async list(user: CurrentUser) {
    const db = this.supabase.forUser(user.club, user.jwt);
    const since = cairoDate(-7);
    const rows = await fetchAll<Row>((from, to) =>
      db
        .from('assignments_v')
        .select('*')
        .eq('inspector_id', user.id)
        .or(`scheduled_date.gte.${since},status.eq.follow_up`)
        .order('scheduled_date')
        .order('id')
        .range(from, to),
    );
    const items = await this.items(db, rows.map((r) => r.id));
    return {
      serverTime: new Date().toISOString(),
      assignments: rows.map((r) => ({ ...r, items: items.get(r.id) ?? [] })),
    };
  }

  /**
   * One round, for anyone RLS lets see it (the assignee, their manager, an
   * admin), with short-lived links for its photos and signature. Signing
   * happens only after this user-scoped read returned the row: RLS is the
   * authorization.
   */
  async get(user: CurrentUser, id: string) {
    const db = this.supabase.forUser(user.club, user.jwt);
    const row = must(await db.from('assignments_v').select('*').eq('id', id).maybeSingle()) as Row | null;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such round' });

    const items = (await this.items(db, [id])).get(id) ?? [];
    const bucket = user.club.bucket;
    const signature = toBucketPath(row.signature_url as string | null, bucket);
    const photos = items.flatMap((i) => (i.photo_paths ?? []).map((p) => toBucketPath(p, bucket)));
    const links = await this.media.sign(
      user.club,
      [signature, ...photos].filter((p): p is string => p !== null),
    );

    return {
      serverTime: new Date().toISOString(),
      assignment: { ...row, items },
      // Keyed by the stored value, so the client can look up exactly what it holds.
      media: Object.fromEntries(
        [row.signature_url as string | null, ...items.flatMap((i) => i.photo_paths ?? [])]
          .filter((v): v is string => !!v)
          .map((v) => [v, links[toBucketPath(v, bucket) ?? ''] ?? null]),
      ) as Record<string, string | null>,
    };
  }

  private async items(db: SupabaseClient, ids: string[]): Promise<Map<string, Item[]>> {
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(ids.length / IDS_PER_REQUEST) }, (_, i) =>
        fetchAll<Item>((from, to) =>
          db
            .from('assignment_items')
            .select('*')
            .in('assignment_id', ids.slice(i * IDS_PER_REQUEST, (i + 1) * IDS_PER_REQUEST))
            .order('assignment_id')
            .order('sort_order')
            .order('id')
            .range(from, to),
        ),
      ),
    );
    const byRound = new Map<string, Item[]>();
    for (const item of pages.flat()) {
      const list = byRound.get(item.assignment_id);
      if (list) list.push(item);
      else byRound.set(item.assignment_id, [item]);
    }
    return byRound;
  }
}

@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  list(@User() user: CurrentUser) {
    return this.assignments.list(user);
  }

  @Get(':id')
  get(@User() user: CurrentUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.assignments.get(user, id);
  }
}

@Module({ imports: [MediaModule], providers: [AssignmentsService], controllers: [AssignmentsController] })
export class AssignmentsModule {}
