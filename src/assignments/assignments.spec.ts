import {
  AssignmentsService,
  cairoDate,
  completedAt,
  evidence,
  fetchAll,
  MAX_VIDEO_BYTES,
  optionalText,
  photoOrVideo,
  scanCode,
} from './assignments.module';
import { photoPath, signaturePath, toBucketPath } from '../media/media.module';
import { classifyRefusal } from '../common/errors.filter';
import { UpstreamError } from '../common/upstream';

describe('toBucketPath', () => {
  const B = 'checklist-media';
  it.each([
    ['photos/a1/i1-123.jpg', 'photos/a1/i1-123.jpg'],
    ['/signatures/a1-9.png', 'signatures/a1-9.png'],
    // the legacy web client stored full public URLs in signature_url
    ['https://ref.supabase.co/storage/v1/object/public/checklist-media/signatures/x%20y.png', 'signatures/x y.png'],
  ])('%s → %s', (value, path) => expect(toBucketPath(value, B)).toBe(path));

  it.each([null, '', 'https://elsewhere.example/a.png', '/data/user/0/app/cache/p.jpg', '/private/var/mobile/p.jpg'])(
    '%s cannot be signed',
    (value) => expect(toBucketPath(value, B)).toBeNull(),
  );
});

describe('cairoDate', () => {
  it('uses the Cairo calendar day, not UTC', () => {
    // 23:30 UTC on 1 Jan is already 2 Jan in Cairo (UTC+2)
    expect(cairoDate(0, Date.UTC(2026, 0, 1, 23, 30))).toBe('2026-01-02');
    expect(cairoDate(-7, Date.UTC(2026, 0, 1, 23, 30))).toBe('2025-12-26');
  });
});

describe('fetchAll', () => {
  it('keeps reading pages until one comes back short, so the row cap never truncates', async () => {
    const pages = [1000, 1000, 3];
    const page = jest.fn(async () => ({ data: new Array(pages.shift()).fill(0), error: null }));
    expect(await fetchAll(page)).toHaveLength(2003);
    expect(page.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('turns an upstream error into an UpstreamError', async () => {
    await expect(fetchAll(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow('boom');
  });
});

describe('evidence paths are derived by the API from ids fixed at capture', () => {
  it('a repeat upload of the same capture writes the same object', () => {
    expect(photoPath('a1', 'i1', 'p1')).toBe('photos/a1/i1-p1.jpg');
    expect(signaturePath('a1', 's1')).toBe('signatures/a1-s1.png');
  });
});

describe('phone input: an app bug is refused (parked), never retried forever', () => {
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e: any) {
      return e.getStatus() === 422 && e.getResponse().refused ? e.getResponse().code : 'NOT_A_REFUSAL';
    }
    return null;
  };

  it('completedAt must carry an offset (SY-7)', () => {
    expect(completedAt('2026-09-23T14:05:00+03:00')).toBe('2026-09-23T14:05:00+03:00');
    expect(completedAt('2026-09-23T11:05:00.123Z')).toBe('2026-09-23T11:05:00.123Z');
    expect(code(() => completedAt('2026-09-23T14:05:00'))).toBe('INVALID_FIELD'); // local time: ambiguous
    expect(code(() => completedAt('yesterday'))).toBe('INVALID_FIELD');
    expect(code(() => completedAt(undefined))).toBe('INVALID_FIELD');
  });

  it('files are checked by their first bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    expect(evidence({ buffer: jpeg, size: 5 }, 'jpeg')).toBe(jpeg);
    expect(evidence({ buffer: png, size: 5 }, 'png')).toBe(png);
    expect(code(() => evidence({ buffer: png, size: 5 }, 'jpeg'))).toBe('INVALID_FILE');
    expect(code(() => evidence(undefined, 'png'))).toBe('INVALID_FILE');
  });

  it("an item's evidence is a JPEG photo or an MP4 clip, each with its own ceiling", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
    expect(photoOrVideo({ buffer: jpeg, size: 5 })).toMatchObject({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(photoOrVideo({ buffer: mp4, size: mp4.length })).toMatchObject({ ext: 'mp4', contentType: 'video/mp4' });
    // A photo up to 5 MB passes; a 6 MB one is refused.
    const fiveMbJpeg = Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024 - jpeg.length)]);
    expect(photoOrVideo({ buffer: fiveMbJpeg, size: fiveMbJpeg.length }).ext).toBe('jpg');
    const bigJpeg = Buffer.concat([jpeg, Buffer.alloc(6 * 1024 * 1024)]);
    expect(code(() => photoOrVideo({ buffer: bigJpeg, size: bigJpeg.length }))).toBe('FILE_TOO_LARGE');
    // Video is at most 1 MB (19 Oct 2026): exactly 1 MB passes, a byte more is refused.
    const mp4Of = (n: number) => Buffer.concat([mp4, Buffer.alloc(n - mp4.length)]);
    expect(photoOrVideo({ buffer: mp4Of(MAX_VIDEO_BYTES), size: MAX_VIDEO_BYTES }).ext).toBe('mp4');
    expect(code(() => photoOrVideo({ buffer: mp4Of(MAX_VIDEO_BYTES + 1), size: MAX_VIDEO_BYTES + 1 }))).toBe('FILE_TOO_LARGE');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(code(() => photoOrVideo({ buffer: png, size: png.length }))).toBe('INVALID_FILE');
    expect(code(() => photoOrVideo(undefined))).toBe('INVALID_FILE');
    expect(photoPath('a1', 'i1', 'p1', 'mp4')).toBe('photos/a1/i1-p1.mp4');
  });

  it('notes and answers are optional text', () => {
    expect(optionalText(undefined, 'note')).toBeNull();
    expect(optionalText(null, 'note')).toBeNull();
    expect(optionalText('Tap was leaking', 'note')).toBe('Tap was leaking');
    expect(code(() => optionalText(42, 'answer'))).toBe('INVALID_FIELD');
    expect(code(() => optionalText('x'.repeat(2001), 'note'))).toBe('INVALID_FIELD');
  });
});

describe('F-06 / PLAT-01: evidence of a closed round cannot be replaced', () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const ROUND = '22222222-2222-2222-2222-222222222222';
  const ITEM = '33333333-3333-3333-3333-333333333333';
  const CAPTURE = '44444444-4444-4444-4444-444444444444';
  const jpeg = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), size: 5 };
  const png = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), size: 5 };

  /** The round as the user reads it (RLS), owned by them, in the given status. */
  function setup(status: string) {
    const rows: Record<string, unknown> = {
      assignments_v: { status, inspector_id: USER, inspector_name: 'A', assignee_ids: [USER] },
      assignment_items: { id: ITEM },
    };
    const query = (table: string): any => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[table], error: null }) };
      return q;
    };
    const rpc = jest.fn(async (_name: string, _args?: unknown) => ({ data: null, error: null }));
    const upload = jest.fn(async () => undefined);
    const svc = new AssignmentsService({ forUser: () => ({ from: query, rpc }) } as any, { upload } as any);
    const user = { id: USER, jwt: 'jwt', club: { slug: 'a' } } as any;
    return { svc, user, rpc, upload };
  }
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: any) => e.getResponse?.().code ?? e.message,
    );

  it.each(['submitted', 'approved'])('a photo into a %s round is refused before anything is uploaded', async (status) => {
    const s = setup(status);
    expect(await refusal(s.svc.photo(s.user, ROUND, ITEM, CAPTURE, jpeg))).toBe('ASSIGNMENT_CLOSED');
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it.each(['submitted', 'approved'])('a submit replayed on a %s round succeeds and writes nothing', async (status) => {
    const s = setup(status);
    const body = { signatureId: CAPTURE, completedAt: '2026-10-18T10:00:00+03:00' };
    expect(await refusal(s.svc.submit(s.user, ROUND, body, png))).toBe('OK');
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it.each(['pending', 'in_progress', 'follow_up'])('a %s round still takes photos and the submit', async (status) => {
    const s = setup(status);
    await s.svc.photo(s.user, ROUND, ITEM, CAPTURE, jpeg);
    await s.svc.submit(s.user, ROUND, { signatureId: CAPTURE, completedAt: '2026-10-18T10:00:00+03:00' }, png);
    expect(s.upload).toHaveBeenCalledTimes(2);
    expect(s.rpc.mock.calls.map(([name]) => name)).toEqual(['attach_item_photo', 'submit_assignment']);
  });
});

describe('POST /assignments/:id/scan: a QR scan is logged as the user, never refused for a wrong code', () => {
  const ROUND = '22222222-2222-2222-2222-222222222222';
  const SCAN = '55555555-5555-5555-5555-555555555555';
  const user = { id: 'u1', jwt: 'jwt', club: { slug: 'a' } } as any;
  const body = { code: 'a3f1c2d4e5f60718293a4b5c6d7e8f90', scannedAt: '2026-10-28T09:15:00+03:00', scanId: SCAN };

  function setup(reply: { data: unknown; error: { message: string } | null }) {
    const rpc = jest.fn(async (_name: string, _args?: unknown) => reply);
    const svc = new AssignmentsService({ forUser: () => ({ rpc }) } as any, {} as any);
    return { svc, rpc };
  }
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: any) => e.getResponse?.().code ?? e.message,
    );

  it('sends the scan to record_place_scan and returns its answer', async () => {
    const s = setup({ data: 'scan', error: null });
    expect(await s.svc.scan(user, ROUND, body)).toEqual({ result: 'scan' });
    expect(s.rpc).toHaveBeenCalledWith('record_place_scan', {
      p_assignment_id: ROUND,
      p_code: body.code,
      p_scanned_at: body.scannedAt,
      p_client_id: SCAN,
    });
  });

  it('a wrong code is a logged bad_code, not a refusal', async () => {
    expect(await setup({ data: 'bad_code', error: null }).svc.scan(user, ROUND, { ...body, code: 'old-sticker' })).toEqual({
      result: 'bad_code',
    });
  });

  it('a replay sends the same scanId, so the database answers with the first result', async () => {
    const s = setup({ data: 'scan', error: null });
    await s.svc.scan(user, ROUND, body);
    await s.svc.scan(user, ROUND, body);
    expect(s.rpc.mock.calls.map(([, args]) => (args as { p_client_id: string }).p_client_id)).toEqual([SCAN, SCAN]);
  });

  it.each([
    [{ ...body, scanId: 'nope' }, 'scanId'],
    [{ ...body, scanId: undefined }, 'scanId'],
    [{ ...body, scannedAt: '2026-10-28T09:15:00' }, 'scannedAt'], // no offset
    [{ ...body, code: '' }, 'code'],
    [{ ...body, code: 42 }, 'code'],
    [{ ...body, code: 'x'.repeat(201) }, 'code'],
  ])('refuses a malformed body (%#: %s) before the database is asked', async (bad, field) => {
    const s = setup({ data: 'scan', error: null });
    const err = await s.svc.scan(user, ROUND, bad).catch((e: any) => e.getResponse());
    expect(err).toMatchObject({ refused: true, code: 'INVALID_FIELD' });
    expect(err.message).toContain(field);
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('scanCode takes a code up to 200 characters', () => {
    expect(scanCode('a'.repeat(200))).toHaveLength(200);
  });

  it("someone else already owns the task: the RPC's ASSIGNMENT_TAKEN is a refusal (parked), like answer and photo", async () => {
    const s = setup({ data: null, error: { message: 'ASSIGNMENT_TAKEN: Badr' } });
    const e = await s.svc.scan(user, ROUND, body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(classifyRefusal((e as Error).message)).toBe('ASSIGNMENT_TAKEN');
    expect(await refusal(setup({ data: null, error: { message: 'Not authorized' } }).svc.scan(user, ROUND, body))).toBe(
      'Not authorized',
    );
    expect(classifyRefusal('Assignment not found')).toBe('ASSIGNMENT_NOT_FOUND');
  });
});
