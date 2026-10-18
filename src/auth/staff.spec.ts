import { LoginsService } from './auth.module';
import type { CurrentUser } from './current-user';

const CALLER = '11111111-1111-1111-1111-111111111111';
const TARGET = '33333333-3333-3333-3333-333333333333';
const ROLE = '22222222-2222-2222-2222-222222222222';
const DEPT = '44444444-4444-4444-4444-444444444444';
const club: any = { slug: 'a', secretKey: 'sk', supabaseUrl: 'https://aaaa.supabase.co' };
const caller = { id: CALLER, jwt: 'db-jwt', club, profile: {} } as unknown as CurrentUser;

/**
 * A secret-key client that answers every query with empty success and
 * remembers what was inserted; `from` is the jest.fn that proves a denied
 * call never reached the secret-key client at all.
 */
function fakeDb() {
  const inserted: Record<string, any[]> = {};
  const calls: Array<[table: string, method: string, ...args: unknown[]]> = [];
  const from = jest.fn((table: string) => {
    let op = 'select';
    const q: any = new Proxy(
      {},
      {
        get: (_t, m: string) => {
          if (m === 'then') {
            const data = op === 'update' ? [{ user_id: TARGET }] : table === 'user_logins' && op === 'select' ? [] : null;
            return (ok: (r: unknown) => void) => ok({ data, error: null });
          }
          return (...args: unknown[]) => {
            calls.push([table, m, ...args]);
            if (m === 'insert' || m === 'update') op = m;
            if (m === 'insert') (inserted[table] ??= []).push(args[0]);
            return q;
          };
        },
      },
    );
    return q;
  });
  return { db: { from }, from, inserted, calls };
}

/** `allowed` is what can_assign_role / can_manage_user answer, as the caller. */
function setup(allowed: unknown) {
  const rpc = jest.fn(async () => ({ data: allowed, error: null }));
  const forUser = jest.fn(() => ({ rpc }));
  const svc = new LoginsService({} as any, { forUser } as any);
  const fake = fakeDb();
  jest.spyOn(svc as any, 'db').mockReturnValue(fake.db);
  return { svc, rpc, forUser, ...fake };
}

const NEW_STAFF = { name: ' Nour ', phone: '01012345678', password: 'longenough', roleId: ROLE };
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => `${e.getStatus?.() ?? e.message} ${e.getResponse?.().code ?? ''}`.trim(),
  );

describe('POST /admin/staff: can_assign_role, asked as the caller, is the only rail', () => {
  it('allowed: asks as the caller with the role and department, then inserts role_id', async () => {
    const s = setup(true);
    await s.svc.createStaff(club, caller, { ...NEW_STAFF, departmentId: DEPT });
    expect(s.forUser).toHaveBeenCalledWith(club, 'db-jwt');
    expect(s.rpc).toHaveBeenCalledWith('can_assign_role', { p_role_id: ROLE, p_department_id: DEPT });
    expect(s.inserted.profiles[0]).toMatchObject({ name: 'Nour', role_id: ROLE, department_id: DEPT });
    expect(s.inserted.profiles[0]).not.toHaveProperty('role');
    expect(s.inserted.user_logins[0]).toMatchObject({ phone: '+201012345678' });
  });

  it('no departmentId asks with null, and creates the profile without one', async () => {
    const s = setup(true);
    await s.svc.createStaff(club, caller, NEW_STAFF);
    expect(s.rpc).toHaveBeenCalledWith('can_assign_role', { p_role_id: ROLE, p_department_id: null });
    expect(s.inserted.profiles[0].department_id).toBeNull();
  });

  it.each([false, null, 'true'])('%p is a 403 and nothing is written', async (answer) => {
    const s = setup(answer);
    expect(await code(s.svc.createStaff(club, caller, NEW_STAFF))).toBe('403 ROLE_NOT_ALLOWED');
    expect(s.from).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed roleId or departmentId (400) before asking the database', async () => {
    const s = setup(true);
    expect(await code(s.svc.createStaff(club, caller, { ...NEW_STAFF, roleId: undefined }))).toBe('400 ROLE_REQUIRED');
    expect(await code(s.svc.createStaff(club, caller, { ...NEW_STAFF, roleId: 'manager' }))).toBe('400 ROLE_REQUIRED');
    expect(await code(s.svc.createStaff(club, caller, { ...NEW_STAFF, departmentId: 7 }))).toBe('400 DEPARTMENT_INVALID');
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('F-05 / USERS-01: a crafted email is looked up as a value, never spliced into an .or() filter', async () => {
    const s = setup(true);
    const crafted = 'q",user_id.not.is.null,email.eq."a@b.co';
    await s.svc.createStaff(club, caller, { ...NEW_STAFF, phone: undefined, email: crafted });
    const logins = s.calls.filter(([t]) => t === 'user_logins');
    expect(logins.some(([, m]) => m === 'or')).toBe(false);
    expect(logins).toContainEqual(['user_logins', 'eq', 'email', crafted]);
    expect(s.inserted.user_logins[0]).toMatchObject({ email: crafted, phone: null });
  });

  it('checks the phone and the email each with its own lookup', async () => {
    const s = setup(true);
    await s.svc.createStaff(club, caller, { ...NEW_STAFF, email: 'Nour@Club.com' });
    const eqs = s.calls.filter(([t, m]) => t === 'user_logins' && m === 'eq');
    expect(eqs).toEqual([
      ['user_logins', 'eq', 'phone', '+201012345678'],
      ['user_logins', 'eq', 'email', 'nour@club.com'],
    ]);
  });

  it('a database error is not a yes: it surfaces and nothing is written', async () => {
    const s = setup(true);
    s.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } } as any);
    expect(await code(s.svc.createStaff(club, caller, NEW_STAFF))).toBe('boom');
    expect(s.from).not.toHaveBeenCalled();
  });
});

describe('POST /admin/staff/:id/password: can_manage_user, asked as the caller', () => {
  it('allowed: sets the password and ends the sessions', async () => {
    const s = setup(true);
    await s.svc.resetPassword(club, caller, TARGET, 'longenough');
    expect(s.rpc).toHaveBeenCalledWith('can_manage_user', { p_user_id: TARGET });
    expect(s.from.mock.calls.map(([t]) => t)).toEqual(['user_logins', 'refresh_tokens']);
  });

  it.each([false, null])('%p is a 403 and nothing is touched', async (answer) => {
    const s = setup(answer);
    expect(await code(s.svc.resetPassword(club, caller, TARGET, 'longenough'))).toBe('403 NOT_AUTHORIZED');
    expect(s.from).not.toHaveBeenCalled();
  });

  it('a short password is refused before anything is asked', async () => {
    const s = setup(true);
    expect(await code(s.svc.resetPassword(club, caller, TARGET, 'short'))).toBe('400 PASSWORD_TOO_SHORT');
    expect(s.rpc).not.toHaveBeenCalled();
  });
});
