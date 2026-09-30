/**
 * The pure rules of signing in, kept apart from the module so they are
 * unit-tested without a database.
 */

export const MIN_PASSWORD = 8;
export const MAX_FAILURES = 10;
export const LOCK_MS = 15 * 60 * 1000;
/** Two parallel refreshes with one token (two phone requests, two portal tabs) are not theft. */
export const ROTATION_GRACE_MS = 60 * 1000;
export const BCRYPT_COST = 12;

/** Egypt, as everywhere else in the product (lib/phone.ts in the portal, login_screen.dart). */
const DIAL = '20';

/**
 * What someone typed in the one sign-in box. Anything with an '@' is an
 * email; everything else must reduce to a 10-digit Egyptian number. The '@'
 * test comes first on purpose: "1012345678@gmail.com" strips to ten digits.
 */
export function parseLogin(typed: unknown): { phone: string } | { email: string } | null {
  if (typeof typed !== 'string') return null;
  const v = typed.trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? { email } : null;
  }
  const digits = v.replace(/\D/g, '').replace(/^20/, '').replace(/^0/, '');
  return digits.length === 10 ? { phone: `+${DIAL}${digits}` } : null;
}

/** After a wrong password: the new count, and a lock once it reaches the limit. */
export function afterFailure(
  failedCount: number,
  now = Date.now(),
): { failed_count: number; locked_until: string | null } {
  const n = failedCount + 1;
  return n >= MAX_FAILURES
    ? { failed_count: 0, locked_until: new Date(now + LOCK_MS).toISOString() }
    : { failed_count: n, locked_until: null };
}

export const isLocked = (lockedUntil: string | null | undefined, now = Date.now()) =>
  !!lockedUntil && Date.parse(lockedUntil) > now;

/**
 * What a presented refresh token is worth:
 *   ok     — live: rotate it.
 *   grace  — just rotated by a parallel refresh: issue again, same family.
 *   reuse  — rotated long ago, or revoked: someone replayed it; kill the family.
 *   dead   — expired or unknown.
 */
export function refreshVerdict(
  row: { revoked_at: string | null; revoked_reason: string | null; expires_at: string } | null,
  now = Date.now(),
): 'ok' | 'grace' | 'reuse' | 'dead' {
  if (!row || Date.parse(row.expires_at) <= now) return 'dead';
  if (!row.revoked_at) return 'ok';
  if (row.revoked_reason === 'rotated' && now - Date.parse(row.revoked_at) < ROTATION_GRACE_MS) return 'grace';
  return row.revoked_reason === 'rotated' ? 'reuse' : 'dead';
}
