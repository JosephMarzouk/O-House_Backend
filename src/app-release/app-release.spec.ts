import { AppReleaseService, AppVersionGuard, appBuild } from './app-release';

const club: any = { slug: 'ohouse' };

function setup(answer: () => Promise<{ data: unknown; error: { message: string } | null }>) {
  const rpc = jest.fn(answer);
  const supabase: any = { forGateway: () => ({ rpc }) };
  const releases = new AppReleaseService(supabase);
  const clubs: any = { bySlug: (s: string) => (s === 'ohouse' ? club : undefined) };
  const guard = new AppVersionGuard(clubs, releases);
  const call = (headers: Record<string, string>) => {
    const req: any = { header: (n: string) => headers[n.toLowerCase()] };
    return guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any).then(
      () => 200,
      (e: any) => `${e.getStatus()} ${e.getResponse().code} ${e.getResponse().updateUrl ?? ''}`.trim(),
    );
  };
  return { call, rpc, releases };
}

describe('F-11 / MOB-01: old app builds are told to update', () => {
  const min5 = async () => ({ data: [{ min_build: 5, update_url: 'https://example.test/app.apk' }], error: null });

  it('a build below the club minimum gets 426 UPGRADE_REQUIRED with the download link', async () => {
    const s = setup(min5);
    expect(await s.call({ 'x-app-version': '4', 'x-club': 'ohouse' })).toBe('426 UPGRADE_REQUIRED https://example.test/app.apk');
  });

  it('the minimum build and newer pass', async () => {
    const s = setup(min5);
    expect(await s.call({ 'x-app-version': '5', 'x-club': 'ohouse' })).toBe(200);
    expect(await s.call({ 'x-app-version': '12', 'x-club': 'ohouse' })).toBe(200);
  });

  it('a call without X-App-Version (the portal) is never checked', async () => {
    const s = setup(min5);
    expect(await s.call({ 'x-club': 'ohouse' })).toBe(200);
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('fails open: an unreadable minimum holds nobody back', async () => {
    const s = setup(async () => ({ data: null, error: { message: 'function app_release() does not exist' } }));
    expect(await s.call({ 'x-app-version': '1', 'x-club': 'ohouse' })).toBe(200);
  });

  it('reads the minimum once a minute per club, not on every call', async () => {
    const s = setup(min5);
    await s.releases.forClub(club, 0);
    await s.releases.forClub(club, 59_000);
    expect(s.rpc).toHaveBeenCalledTimes(1);
    await s.releases.forClub(club, 61_000);
    expect(s.rpc).toHaveBeenCalledTimes(2);
  });

  it('only a plain build number counts as a version', () => {
    expect(appBuild('7')).toBe(7);
    expect(appBuild(' 12 ')).toBe(12);
    expect(appBuild(undefined)).toBeNull();
    expect(appBuild('1.0.0')).toBeNull();
    expect(appBuild('-1')).toBeNull();
  });
});
