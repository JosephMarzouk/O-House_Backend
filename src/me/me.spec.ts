import { clubLocation, MeController } from './me.module';
import type { CurrentUser } from '../auth/current-user';

describe('clubLocation', () => {
  it('turns the row into numbers, whether PostgREST sends numeric as a number or as text', () => {
    expect(clubLocation({ lat: 30.0444, lng: 31.2357, radius_m: 200 })).toEqual({ lat: 30.0444, lng: 31.2357, radiusM: 200 });
    expect(clubLocation({ lat: '30.0444', lng: '-31.5', radius_m: 50 })).toEqual({ lat: 30.0444, lng: -31.5, radiusM: 50 });
  });

  it('is null until an admin sets it, so the app runs no zone check', () => {
    expect(clubLocation(null)).toBeNull();
  });
});

describe('GET /me', () => {
  const user = { id: 'u1', jwt: 'db-jwt', club: { slug: 'a', name: { en: 'A', ar: 'A' }, logoUrl: null } } as unknown as CurrentUser;
  const ACCESS = {
    role: { id: 'r1', key: null, name_en: 'Head of Sports', name_ar: 'رئيس الرياضة', locked: false },
    scope: 'departments',
    departments: ['d1'],
    permissions: ['users.create'],
    assignable: ['r2'],
  };

  /** A per-user client whose tables answer with rows and whose my_access answers with `access`. */
  function controller(access: unknown) {
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    const rpc = jest.fn(() => ok(access));
    const db = {
      rpc,
      from: (table: string) => ({
        select: () =>
          table === 'club_pages'
            ? ok([])
            : { eq: () => ({ single: () => ok({ id: 'u1', role: 'cleaner' }) }), maybeSingle: () => ok(null) },
      }),
    };
    return { rpc, me: new MeController({ forUser: () => db } as any) };
  }

  it('carries my_access as `access`, next to the old profile.role', async () => {
    const c = controller(ACCESS);
    const r = await c.me.me(user);
    expect(c.rpc).toHaveBeenCalledWith('my_access');
    expect(r.access).toEqual(ACCESS);
    expect(r.profile).toMatchObject({ role: 'cleaner' });
  });

  it('is null when the database finds no active role', async () => {
    expect((await controller(null).me.me(user)).access).toBeNull();
  });
});

describe('PUT / DELETE /me/devices', () => {
  const user = { id: 'u1', jwt: 'db-jwt', club: { slug: 'a' } } as unknown as CurrentUser;
  function controller() {
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    return { rpc, me: new MeController({ forUser: () => ({ rpc }) } as any) };
  }

  it('registers the token as the user, so it moves to whoever signs in on a shared phone', async () => {
    const c = controller();
    await c.me.registerDevice(user, 'fcm-token', 'android');
    expect(c.rpc).toHaveBeenCalledWith('register_device_token', { p_token: 'fcm-token', p_platform: 'android' });
  });

  it('refuses a missing token or an unknown platform (422: the phone parks, not retries)', async () => {
    const c = controller();
    await expect(c.me.registerDevice(user, '', 'android')).rejects.toMatchObject({ response: { code: 'INVALID_FIELD' } });
    await expect(c.me.registerDevice(user, 't', 'web')).rejects.toMatchObject({ response: { code: 'INVALID_FIELD' } });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('unregisters only through the user-scoped function', async () => {
    const c = controller();
    await c.me.unregisterDevice(user, 'fcm-token');
    expect(c.rpc).toHaveBeenCalledWith('unregister_device_token', { p_token: 'fcm-token' });
  });
});
