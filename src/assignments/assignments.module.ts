import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.module';
import { MediaModule, MediaService, photoPath, signaturePath, toBucketPath } from '../media/media.module';
import { CurrentUser, User } from '../auth/current-user';
import { must } from '../common/upstream';
import { isUuid, refused, Uuid } from '../common/errors.filter';

type Row = Record<string, unknown> & { id: string };
type Item = Row & { assignment_id: string; photo_paths: string[] | null };

const PAGE = 1000; // PostgREST's default max-rows: past it a response is cut SILENTLY
const IDS_PER_REQUEST = 50;
// The phone compresses to a 1600 px long edge (~300 KB); these only stop abuse.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// A camera clip of at most 30 s (the app's maxDuration). image_picker cannot
// compress video. 50 MB is also the bucket's limit (Supabase's default
// project-wide upload limit), so raising one means raising both.
// ponytail: multer holds the upload in memory; switch the evidence route to
// disk storage if several phones upload clips at once.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_TEXT = 2000;

type Upload = { buffer: Buffer; size: number } | undefined;

/** Optional free text from the phone. Anything else is the app's bug: refused, so it parks instead of looping. */
export function optionalText(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > MAX_TEXT) {
    throw refused('INVALID_FIELD', `${field} must be text of at most ${MAX_TEXT} characters`);
  }
  return v;
}

const MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] } as const;

/** The file really is what its path will claim (by its first bytes, not the client's content type). */
export function evidence(file: Upload, kind: keyof typeof MAGIC): Buffer {
  const b = file?.buffer;
  if (!b || !MAGIC[kind].every((byte, i) => b[i] === byte)) {
    throw refused('INVALID_FILE', `Expected a ${kind.toUpperCase()} file`);
  }
  return b;
}

/**
 * An item's evidence: a JPEG photo, or an MP4 clip (`ftyp` box at byte 4),
 * told apart by the bytes, never the client's content type. Each kind has its
 * own size ceiling; anything else is refused and parks on the phone.
 */
export function photoOrVideo(file: Upload): { bytes: Buffer; ext: 'jpg' | 'mp4'; contentType: string } {
  const b = file?.buffer;
  if (b && MAGIC.jpeg.every((byte, i) => b[i] === byte)) {
    if (b.length > MAX_PHOTO_BYTES) throw refused('FILE_TOO_LARGE', 'Photo is too large');
    return { bytes: b, ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (b && b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    return { bytes: b, ext: 'mp4', contentType: 'video/mp4' };
  }
  throw refused('INVALID_FILE', 'Expected a JPEG photo or an MP4 video');
}

/** SY-7: the capture time must carry its offset, or "before the deadline" is ambiguous by hours. */
export function completedAt(v: unknown): string {
  const ok =
    typeof v === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(v) &&
    !Number.isNaN(Date.parse(v));
  if (!ok) throw refused('INVALID_FIELD', 'completedAt must be ISO-8601 with an offset');
  return v;
}

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

/** Statuses whose evidence is final: nothing may be uploaded into them. follow_up stays open on purpose. */
const CLOSED = new Set(['submitted', 'approved']);

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
        // Mine, or given to several of us and not yet claimed. Once another
        // assignee acts first it drops off this list on the next refresh.
        .or(`inspector_id.eq.${user.id},and(inspector_id.is.null,assignee_ids.cs.{${user.id}})`)
        // A multi-day task stays while its last day is in the window.
        .or(`scheduled_date.gte.${since},end_date.gte.${since},status.eq.follow_up`)
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

  // ---- writes: one RPC each, as the user. The RPC is the authority. ----

  async answer(user: CurrentUser, itemId: string, body: { answer?: unknown; note?: unknown }) {
    const params = {
      p_item_id: itemId,
      p_note: optionalText(body?.note, 'note'),
      p_answer: optionalText(body?.answer, 'answer'),
    };
    must(await this.supabase.forUser(user.club, user.jwt).rpc('mark_item_done', params));
  }

  async photo(user: CurrentUser, id: string, itemId: string, photoId: unknown, file: Upload) {
    if (!isUuid(photoId)) throw refused('INVALID_FIELD', 'photoId must be a uuid');
    const { bytes, ext, contentType } = photoOrVideo(file);
    const db = this.supabase.forUser(user.club, user.jwt);
    // Before the upload, not after: the upload overwrites (upsert), so a
    // check left to the RPC would refuse only once the evidence of a closed
    // round was already replaced (F-06).
    if (CLOSED.has(await this.assertAssignee(db, user, id, itemId))) {
      throw refused('ASSIGNMENT_CLOSED', 'Assignment is closed');
    }
    const path = photoPath(id, itemId, photoId, ext);
    await this.media.upload(user.club, path, bytes, contentType);
    must(await db.rpc('attach_item_photo', { p_item_id: itemId, p_storage_path: path }));
  }

  async submit(
    user: CurrentUser,
    id: string,
    body: { signatureId?: unknown; completedAt?: unknown; note?: unknown },
    file: Upload,
  ) {
    if (!isUuid(body?.signatureId)) throw refused('INVALID_FIELD', 'signatureId must be a uuid');
    const params = {
      p_assignment_id: id,
      p_signature_path: signaturePath(id, body.signatureId),
      p_completed_at: completedAt(body.completedAt),
      p_note: optionalText(body.note, 'note'),
    };
    const bytes = evidence(file, 'png');
    const db = this.supabase.forUser(user.club, user.jwt);
    // Already submitted or approved: a replay of a submit whose reply was
    // lost. Success, as submit_assignment would answer, but nothing is
    // written, so the stored signature can't be swapped afterwards (F-06).
    if (CLOSED.has(await this.assertAssignee(db, user, id))) return;
    await this.media.upload(user.club, params.p_signature_path, bytes, 'image/png');
    must(await db.rpc('submit_assignment', params));
  }

  /**
   * Authorizes the secret-key upload that follows: the round (and item) must
   * be readable as the user, and theirs — owned by them, or given to them and
   * not yet claimed. A manager can read a report's round but must not write
   * evidence into it. The RPC after the upload re-checks everything, claims
   * the round, and refuses if it is closed or someone else got there first.
   */
  private async assertAssignee(db: SupabaseClient, user: CurrentUser, id: string, itemId?: string): Promise<string> {
    const [round, item] = await Promise.all([
      db
        .from('assignments_v')
        .select('status, inspector_id, inspector_name, assignee_ids')
        .eq('id', id)
        .maybeSingle(),
      itemId
        ? db.from('assignment_items').select('id').eq('id', itemId).eq('assignment_id', id).maybeSingle()
        : Promise.resolve({ data: { id: '' }, error: null }),
    ]);
    const r = must(round) as {
      status: string;
      inspector_id: string | null;
      inspector_name: string | null;
      assignee_ids: string[] | null;
    } | null;
    if (!r) throw refused('ASSIGNMENT_NOT_FOUND', 'Assignment not found');
    if (r.inspector_id !== user.id) {
      if (!(r.assignee_ids ?? []).includes(user.id)) throw refused('NOT_AUTHORIZED', 'Not authorized');
      if (r.inspector_id) {
        throw refused('ASSIGNMENT_TAKEN', `ASSIGNMENT_TAKEN: ${r.inspector_name ?? ''}`);
      }
    }
    if (!must(item)) throw refused('ITEM_NOT_FOUND', 'Item not found');
    return r.status;
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

  @Post(':id/items/:itemId/answer')
  answer(
    @User() user: CurrentUser,
    @Param('id', Uuid) _id: string,
    @Param('itemId', Uuid) itemId: string,
    @Body() body: { answer?: unknown; note?: unknown },
  ) {
    return this.assignments.answer(user, itemId, body);
  }

  @Post(':id/items/:itemId/photos')
  // The larger ceiling here; photoOrVideo() then holds a JPEG to MAX_PHOTO_BYTES.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } }))
  photo(
    @User() user: CurrentUser,
    @Param('id', Uuid) id: string,
    @Param('itemId', Uuid) itemId: string,
    @Body('photoId') photoId: unknown,
    @UploadedFile() file: Upload,
  ) {
    return this.assignments.photo(user, id, itemId, photoId, file);
  }

  @Post(':id/submit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIGNATURE_BYTES, files: 1 } }))
  submit(
    @User() user: CurrentUser,
    @Param('id', Uuid) id: string,
    @Body() body: { signatureId?: unknown; completedAt?: unknown; note?: unknown },
    @UploadedFile() file: Upload,
  ) {
    return this.assignments.submit(user, id, body, file);
  }
}

@Module({ imports: [MediaModule], providers: [AssignmentsService], controllers: [AssignmentsController] })
export class AssignmentsModule {}
