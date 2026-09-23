import { Reflector } from '@nestjs/core';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { AuthGuard } from './auth.guard';
import type { Club } from '../clubs/clubs';

const club = (slug: string, ref: string): Club => ({
  slug,
  code: slug.toUpperCase(),
  name: { en: slug, ar: slug },
  logoUrl: null,
  supabaseUrl: `https://${ref}.supabase.co`,
  publishableKey: 'pk',
  secretKey: 'sk',
  gatewayKey: 'gk',
  bucket: 'checklist-media',
});
const A = club('a', 'aaaa');
const B = club('b', 'bbbb');

const USER = '11111111-1111-1111-1111-111111111111';
const claimsFor = (c: Club, extra: object = {}) => ({
  sub: USER,
  role: 'authenticated',
  aud: 'authenticated',
  iss: `${c.supabaseUrl}/auth/v1`,
  ...extra,
});
const PROFILE = { id: USER, role: 'cleaner', active: true };

function setup(opts: { claims?: unknown; error?: unknown; profile?: unknown } = {}) {
  const getClaims = jest.fn(async () =>
    opts.error ? { data: null, error: opts.error } : { data: { claims: opts.claims ?? claimsFor(A) }, error: null },
  );
  const maybeSingle = jest.fn(async () => ({ data: 'profile' in opts ? opts.profile : PROFILE, error: null }));
  const supabase: any = {
    authClient: () => ({ auth: { getClaims } }),
    forUser: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }),
  };
  const clubs: any = { bySlug: (s: string) => ({ a: A, b: B })[s as 'a' | 'b'] };
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const guard = new AuthGuard(reflector, clubs, supabase);

  const call = (headers: Record<string, string>, ip = '1.2.3.4') => {
    const req: any = { ip, header: (n: string) => headers[n.toLowerCase()] };
    const ctx: any = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };
    return guard.canActivate(ctx).then(
      (): any => ({ status: 200, user: req.user }),
      (e): any => ({ status: e.getStatus?.() ?? 500, body: e.getResponse?.() }),
    );
  };
  return { call, getClaims, maybeSingle };
}

const auth = { authorization: 'Bearer tok' };

describe('AuthGuard', () => {
  it('lets a valid staff token through and sets the user for its club', async () => {
    const r = await setup().call({ ...auth, 'x-club': 'a' });
    expect(r.status).toBe(200);
    expect(r.user).toMatchObject({ id: USER, jwt: 'tok', club: { slug: 'a' } });
  });

  it('refuses a club A token presented to club B (issuer mismatch) → 401', async () => {
    const r = await setup({ claims: claimsFor(A) }).call({ ...auth, 'x-club': 'b' });
    expect(r.status).toBe(401);
  });

  it('requires X-Club, and a known one', async () => {
    expect((await setup().call(auth)).status).toBe(400);
    expect((await setup().call({ ...auth, 'x-club': 'zzz' })).status).toBe(404);
  });

  it('refuses a missing token, or a non-user role such as anon', async () => {
    expect((await setup().call({ 'x-club': 'a' })).status).toBe(401);
    expect((await setup({ claims: claimsFor(A, { role: 'anon' }) }).call({ ...auth, 'x-club': 'a' })).status).toBe(401);
  });

  it('refuses a malformed token that makes getClaims throw → 401, not 503', async () => {
    const s = setup();
    s.getClaims.mockRejectedValueOnce(new Error('Invalid UTF-8 sequence'));
    expect((await s.call({ ...auth, 'x-club': 'a' })).status).toBe(401);
  });

  it('answers 503, not 401, when the JWKS cannot be fetched (no refresh loop on phones)', async () => {
    const r = await setup({ error: new AuthRetryableFetchError('network', 0) }).call({ ...auth, 'x-club': 'a' });
    expect(r.status).toBe(503);
  });

  it('refuses a caller with no profile, no role, or deactivated → 403', async () => {
    for (const profile of [null, { ...PROFILE, role: null }, { ...PROFILE, active: false }]) {
      expect((await setup({ profile }).call({ ...auth, 'x-club': 'a' })).status).toBe(403);
    }
  });

  it('caches the profile per club and user for 60 s', async () => {
    const s = setup();
    await s.call({ ...auth, 'x-club': 'a' });
    await s.call({ ...auth, 'x-club': 'a' });
    expect(s.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('throttles an IP after 30 failed attempts in a minute → 429', async () => {
    const s = setup({ claims: claimsFor(A, { role: 'anon' }) });
    for (let i = 0; i < 30; i++) await s.call({ ...auth, 'x-club': 'a' }, '9.9.9.9');
    expect((await s.call({ ...auth, 'x-club': 'a' }, '9.9.9.9')).status).toBe(429);
    expect((await s.call({ ...auth, 'x-club': 'a' }, '8.8.8.8')).status).toBe(401); // others unaffected
  });
});
