import { UserThrottlerGuard } from './app.module';

/** getTracker only: the counting itself is @nestjs/throttler's. */
const tracker = (req: Record<string, any>): Promise<string> =>
  (Object.create(UserThrottlerGuard.prototype) as any).getTracker(req);

describe('F-07 / AUTH-01: sign-in is limited per IP and login, not per IP', () => {
  it('two people signing in from one Wi-Fi IP are counted apart', async () => {
    const a = await tracker({ ip: '41.0.0.1', body: { login: '01012345678' } });
    const b = await tracker({ ip: '41.0.0.1', body: { login: '01098765432' } });
    expect(a).not.toBe(b);
  });

  it('every way of typing one login counts as that login', async () => {
    const forms = ['01012345678', '+201012345678', '1012345678', ' 0101 234 5678 '];
    const keys = await Promise.all(forms.map((login) => tracker({ ip: '41.0.0.1', body: { login } })));
    expect(new Set(keys)).toEqual(new Set(['41.0.0.1:+201012345678']));
    expect(await tracker({ ip: '41.0.0.1', body: { login: 'Nour@Club.COM' } })).toBe('41.0.0.1:nour@club.com');
  });

  it('a body with no valid login (refresh, logout, junk) falls back to the IP', async () => {
    expect(await tracker({ ip: '41.0.0.1', body: { refreshToken: 'x' } })).toBe('41.0.0.1');
    expect(await tracker({ ip: '41.0.0.1', body: { login: 'nope' } })).toBe('41.0.0.1');
    expect(await tracker({ ip: '41.0.0.1' })).toBe('41.0.0.1');
  });

  it('a signed-in request is still counted per club and user', async () => {
    expect(await tracker({ ip: '41.0.0.1', user: { id: 'u1', club: { slug: 'ohouse' } } })).toBe('ohouse:u1');
  });
});
