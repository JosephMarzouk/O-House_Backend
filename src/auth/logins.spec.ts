import { afterFailure, grantableRoles, isLocked, LOCK_MS, parseLogin, refreshVerdict } from './logins';
import { sha256, newRefreshToken } from './tokens';

describe('parseLogin: one box for a phone or an email', () => {
  it.each([
    ['1012345678', { phone: '+201012345678' }],
    ['01012345678', { phone: '+201012345678' }], // trunk 0
    ['+20 101 234 5678', { phone: '+201012345678' }],
    ['201012345678', { phone: '+201012345678' }],
    ['  Admin@Club.COM ', { email: 'admin@club.com' }],
    ['1012345678@gmail.com', { email: '1012345678@gmail.com' }], // '@' first: an address, not a phone
  ])('%s', (typed, expected) => expect(parseLogin(typed)).toEqual(expected));

  it.each(['', '12345', 'not an email@', 'a@b', 42, null])('%p is no login', (typed) =>
    expect(parseLogin(typed)).toBeNull(),
  );
});

describe('lockout', () => {
  it('locks for 15 minutes on the 10th wrong password, and starts counting again', () => {
    const now = Date.UTC(2026, 8, 27, 12);
    expect(afterFailure(0, now)).toEqual({ failed_count: 1, locked_until: null });
    expect(afterFailure(8, now)).toEqual({ failed_count: 9, locked_until: null });
    const locked = afterFailure(9, now);
    expect(locked.failed_count).toBe(0);
    expect(Date.parse(locked.locked_until!)).toBe(now + LOCK_MS);
    expect(isLocked(locked.locked_until, now + LOCK_MS - 1)).toBe(true);
    expect(isLocked(locked.locked_until, now + LOCK_MS)).toBe(false);
    expect(isLocked(null)).toBe(false);
  });
});

describe('refresh tokens', () => {
  const now = Date.UTC(2026, 8, 27, 12);
  const live = { revoked_at: null, revoked_reason: null, expires_at: new Date(now + 1000).toISOString() };
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('rotates a live one, and forgives a parallel refresh for 60 s', () => {
    expect(refreshVerdict(live, now)).toBe('ok');
    expect(refreshVerdict({ ...live, revoked_at: ago(5_000), revoked_reason: 'rotated' }, now)).toBe('grace');
  });

  it('treats a long-rotated one as stolen, and a logged-out or reset one as dead', () => {
    expect(refreshVerdict({ ...live, revoked_at: ago(61_000), revoked_reason: 'rotated' }, now)).toBe('reuse');
    expect(refreshVerdict({ ...live, revoked_at: ago(1_000), revoked_reason: 'logout' }, now)).toBe('dead');
    expect(refreshVerdict({ ...live, revoked_at: ago(1_000), revoked_reason: 'reset' }, now)).toBe('dead');
    expect(refreshVerdict({ ...live, expires_at: ago(1) }, now)).toBe('dead');
    expect(refreshVerdict(null, now)).toBe('dead');
  });

  it('are random and stored only as a hash', () => {
    const t = newRefreshToken();
    expect(t).toHaveLength(43);
    expect(newRefreshToken()).not.toBe(t);
    expect(sha256(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('grantableRoles: creating an account and resetting one are the same reach', () => {
  it('admin: every staff role but admin; manager: inspector and cleaner; others: none', () => {
    expect(grantableRoles('admin')).toEqual(['manager', 'inspector', 'cleaner']);
    expect(grantableRoles('manager')).toEqual(['inspector', 'cleaner']);
    expect(grantableRoles('inspector')).toEqual([]);
    expect(grantableRoles(null)).toEqual([]);
  });
});
