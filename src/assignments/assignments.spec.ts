import { cairoDate, fetchAll } from './assignments.module';
import { toBucketPath } from '../media/media.module';

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
