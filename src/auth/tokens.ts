import { Injectable } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, sign, verify } from 'node:crypto';
import type { Club, EcJwk } from '../clubs/clubs';

/**
 * The tokens the API issues. Node's own crypto, no JWT library: ES256 over
 * base64url is a few lines, and the ones that matter (signature, expiry,
 * issuer, audience) are all checked below.
 *
 *   access token — what the phone and the portal send. Signed with the club's
 *                  apiJwtKey, which only the API holds; Postgres does not
 *                  trust it, so it is useless against the Data API.
 *   db token     — what the API sends to PostgREST on the user's behalf.
 *                  Signed with the club's dbSigningKey, a key imported into
 *                  that Supabase project's JWT signing keys, so auth.uid(),
 *                  RLS and every RPC guard work exactly as before. Never
 *                  leaves the API, except to the portal SERVER (GET
 *                  /auth/db-token, which demands the gateway key).
 *   refresh token — 32 random bytes, stored only as a SHA-256 hash.
 */
export const ACCESS_TTL_S = 15 * 60;
export const DB_TTL_S = 5 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DB_REUSE_MS = 4 * 60 * 1000; // re-mint a minute before a db token expires

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signJwt(payload: Record<string, unknown>, key: KeyObject, kid?: string): string {
  const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', ...(kid ? { kid } : {}) }));
  const body = b64u(JSON.stringify(payload));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/** The claims of a valid, unexpired ES256 token from `iss` for `aud`; null for anything else. */
export function verifyJwt(
  token: string,
  key: KeyObject,
  expected: { iss: string; aud: string },
  now = Date.now(),
): (Record<string, unknown> & { sub: string }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (head?.alg !== 'ES256') return null; // never "none", never a symmetric alg
    const ok = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof c?.exp !== 'number' || c.exp * 1000 <= now) return null;
    if (c.iss !== expected.iss || c.aud !== expected.aud || typeof c.sub !== 'string') return null;
    return c;
  } catch {
    return null; // malformed base64 / JSON: the caller's fault, a plain rejection
  }
}

export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const apiIssuer = (club: Club) => `ohouse-api/${club.slug}`;
export const API_AUDIENCE = 'ohouse';

type Keys = { api: KeyObject; apiPublic: KeyObject; db: KeyObject; dbKid: string };

@Injectable()
export class TokenService {
  // Keyed by club slug: a key is never shared across clubs.
  private readonly keys = new Map<string, Keys>();
  // ponytail: per instance, like the guard's profile cache.
  private readonly dbTokens = new Map<string, { token: string; until: number }>();

  private keysFor(club: Club): Keys {
    let k = this.keys.get(club.slug);
    if (!k) {
      const api = createPrivateKey({ key: club.apiJwtKey as EcJwk & Record<string, string>, format: 'jwk' });
      k = {
        api,
        apiPublic: createPublicKey(api),
        db: createPrivateKey({ key: club.dbSigningKey as EcJwk & Record<string, string>, format: 'jwk' }),
        dbKid: club.dbSigningKey.kid!,
      };
      this.keys.set(club.slug, k);
    }
    return k;
  }

  accessToken(club: Club, userId: string, now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    return signJwt(
      { sub: userId, iss: apiIssuer(club), aud: API_AUDIENCE, iat, exp: iat + ACCESS_TTL_S },
      this.keysFor(club).api,
    );
  }

  /** The user id of a valid access token for this club; null otherwise. */
  verifyAccess(club: Club, token: string, now = Date.now()): string | null {
    return verifyJwt(token, this.keysFor(club).apiPublic, { iss: apiIssuer(club), aud: API_AUDIENCE }, now)?.sub ?? null;
  }

  /** A short-lived token PostgREST accepts as this user (role authenticated). */
  dbToken(club: Club, userId: string, now = Date.now()): string {
    const key = `${club.slug}:${userId}`;
    const hit = this.dbTokens.get(key);
    if (hit && hit.until > now) return hit.token;

    const iat = Math.floor(now / 1000);
    const k = this.keysFor(club);
    const token = signJwt(
      {
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        iss: `${club.supabaseUrl}/auth/v1`,
        iat,
        exp: iat + DB_TTL_S,
      },
      k.db,
      k.dbKid,
    );
    if (this.dbTokens.size > 10_000) this.dbTokens.clear();
    this.dbTokens.set(key, { token, until: now + DB_REUSE_MS });
    return token;
  }
}
