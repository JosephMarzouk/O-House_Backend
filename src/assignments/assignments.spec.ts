import { AssignmentsService, cairoDate, completedAt, evidence, fetchAll, optionalText, photoOrVideo } from './assignments.module';
import { photoPath, signaturePath, toBucketPath } from '../media/media.module';

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
    // A 6 MB "photo" is refused even though the route admits 50 MB for video.
    const bigJpeg = Buffer.concat([jpeg, Buffer.alloc(6 * 1024 * 1024)]);
    expect(code(() => photoOrVideo({ buffer: bigJpeg, size: bigJpeg.length }))).toBe('FILE_TOO_LARGE');
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
