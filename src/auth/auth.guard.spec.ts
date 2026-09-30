import { generateKeyPairSync } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { TokenService } from './tokens';
import type { Club, EcJwk } from '../clubs/clubs';

const jwk = (kid?: string) =>
  ({ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid }) as EcJwk;

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
  hosts: [],
  apiJwtKey: jwk(),
  dbSigningKey: jwk(`db-${slug}`),
});
const A = club('a', 'aaaa');
const B = club('b', 'bbbb');

const USER = '11111111-1111-1111-1111-111111111111';
const PROFILE = { id: USER, role: 'cleaner', role_id: '22222222-2222-2222-2222-222222222222', active: true };

function setup(opts: { profile?: unknown } = {}) {
  const tokens = new TokenService();
  const maybeSingle = jest.fn(async () => ({ data: 'profile' in opts ? opts.profile : PROFILE, error: null }));
  const forUser = jest.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }));
  const supabase: any = { forUser };
  const clubs: any = { bySlug: (s: string) => ({ a: A, b: B })[s as 'a' | 'b'] };
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const guard = new AuthGuard(reflector, clubs, supabase, tokens);

  const call = (headers: Record<string, string>, ip = '1.2.3.4') => {
    const req: any = { ip, header: (n: string) => headers[n.toLowerCase()] };
    const ctx: any = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };
    return guard.canActivate(ctx).then(
      (): any => ({ status: 200, user: req.user }),
      (e): any => ({ status: e.getStatus?.() ?? 500, body: e.getResponse?.() }),
    );
  };
  const bearer = (c: Club, now?: number) => ({ authorization: `Bearer ${tokens.accessToken(c, USER, now)}` });
  return { call, bearer, maybeSingle, forUser, tokens };
}

describe('AuthGuard', () => {
  it('lets a valid access token through, and queries Postgres with a minted db token', async () => {
    const s = setup();
    const r = await s.call({ ...s.bearer(A), 'x-club': 'a' });
    expect(r.status).toBe(200);
    expect(r.user).toMatchObject({ id: USER, club: { slug: 'a' } });
    // The db token, not the access token, is what reaches PostgREST.
    const claims = JSON.parse(Buffer.from(r.user.jwt.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ sub: USER, role: 'authenticated', aud: 'authenticated', iss: 'https://aaaa.supabase.co/auth/v1' });
    const head = JSON.parse(Buffer.from(r.user.jwt.split('.')[0], 'base64url').toString());
    expect(head).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'db-a' });
  });

  it('refuses a club A token presented to club B → 401', async () => {
    const s = setup();
    expect((await s.call({ ...s.bearer(A), 'x-club': 'b' })).status).toBe(401);
  });

  it('requires X-Club, and a known one', async () => {
    const s = setup();
    expect((await s.call(s.bearer(A))).status).toBe(400);
    expect((await s.call({ ...s.bearer(A), 'x-club': 'zzz' })).status).toBe(404);
  });

  it('refuses a missing, garbage, expired or tampered token → 401', async () => {
    const s = setup();
    expect((await s.call({ 'x-club': 'a' })).status).toBe(401);
    expect((await s.call({ authorization: 'Bearer not.a.jwt', 'x-club': 'a' })).status).toBe(401);
    const old = s.bearer(A, Date.now() - 16 * 60 * 1000); // 15 min lifetime
    expect((await s.call({ ...old, 'x-club': 'a' })).status).toBe(401);
    const [h, , sig] = s.bearer(A).authorization.slice(7).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', iss: 'ohouse-api/a', aud: 'ohouse', exp: 9e9 })).toString('base64url');
    expect((await s.call({ authorization: `Bearer ${h}.${forged}.${sig}`, 'x-club': 'a' })).status).toBe(401);
  });

  it('refuses the database token itself as an access token', async () => {
    const s = setup();
    const db = s.tokens.dbToken(A, USER);
    expect((await s.call({ authorization: `Bearer ${db}`, 'x-club': 'a' })).status).toBe(401);
  });

  it('refuses a caller with no profile, no role_id, or deactivated → 403', async () => {
    // role_id is the truth: the role text mirror alone does not count.
    for (const profile of [null, { ...PROFILE, role_id: null }, { ...PROFILE, active: false }]) {
      const s = setup({ profile });
      expect((await s.call({ ...s.bearer(A), 'x-club': 'a' })).status).toBe(403);
    }
  });

  it('lets a custom role through: role_id present, role text irrelevant', async () => {
    const s = setup({ profile: { ...PROFILE, role: null } });
    expect((await s.call({ ...s.bearer(A), 'x-club': 'a' })).status).toBe(200);
  });

  it('caches the profile per club and user for 60 s', async () => {
    const s = setup();
    await s.call({ ...s.bearer(A), 'x-club': 'a' });
    await s.call({ ...s.bearer(A), 'x-club': 'a' });
    expect(s.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('throttles an IP after 30 failed attempts in a minute → 429', async () => {
    const s = setup();
    const bad = { authorization: 'Bearer x.y.z', 'x-club': 'a' };
    for (let i = 0; i < 30; i++) await s.call(bad, '9.9.9.9');
    expect((await s.call(bad, '9.9.9.9')).status).toBe(429);
    expect((await s.call(bad, '8.8.8.8')).status).toBe(401); // others unaffected
  });
});
