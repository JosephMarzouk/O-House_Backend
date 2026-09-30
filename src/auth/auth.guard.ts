import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenService } from './tokens';
import { ClubsService } from '../clubs/clubs.module';
import type { Club } from '../clubs/clubs';
import { SupabaseService } from '../supabase/supabase.module';
import { must } from '../common/upstream';
import { IS_PUBLIC } from './public.decorator';
import { PROFILE_COLUMNS, Profile } from './current-user';

const PROFILE_TTL_MS = 60_000;
const FAILED_AUTH_LIMIT = 30; // per IP per minute
const FAILED_AUTH_WINDOW_MS = 60_000;

/**
 * Global, so every route is locked unless marked @Public().
 *
 *   1. X-Club names the club; its registry entry is the only source of URLs
 *      and keys for the rest of the request.
 *   2. The Bearer token is the API's own access token (POST /auth/login),
 *      verified with THAT club's key, and its issuer must be that club. A
 *      club A token sent with X-Club: b fails both checks.
 *   3. The caller must have a profile with a role (role_id), and not be deactivated.
 *      A caller with no profile never reaches Postgres through the API: that
 *      is the NULL-role case that made the role RPCs fail open.
 *
 * Postgres then sees a short-lived token minted for this user (tokens.ts),
 * and verifies it again with the key the club imported.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  // ponytail: in-memory, per instance. Fine for one Railway instance; move to
  // the database or Redis only if the API ever runs several instances.
  private readonly profiles = new Map<string, { profile: Profile; expires: number }>();
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly clubs: ClubsService,
    private readonly supabase: SupabaseService,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    const ip = req.ip ?? 'unknown';
    this.assertNotBlocked(ip);

    const slug = req.header('x-club');
    if (!slug) throw new BadRequestException({ code: 'CLUB_REQUIRED', message: 'X-Club header is required' });
    const club = this.clubs.bySlug(slug);
    if (!club) throw new NotFoundException({ code: 'UNKNOWN_CLUB', message: 'Unknown club' });

    const token = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (!token) this.reject(ip);

    // Our own access token, checked against THIS club's key and issuer: a
    // club A token sent with X-Club: b fails the signature and the issuer.
    // Verified locally, so there is no key server to be unreachable.
    const userId = this.tokens.verifyAccess(club, token);
    if (!userId) this.reject(ip);

    // What the rest of the request uses to reach Postgres as this person.
    const jwt = this.tokens.dbToken(club, userId);
    const profile = await this.profile(club, userId, jwt);
    if (!profile || !profile.role_id || profile.active === false) {
      throw new ForbiddenException({ code: 'NO_ACCESS', message: 'This account has no access' });
    }

    req.user = { id: userId, jwt, club, profile };
    return true;
  }

  private async profile(club: Club, userId: string, jwt: string): Promise<Profile | null> {
    const key = `${club.slug}:${userId}`;
    const hit = this.profiles.get(key);
    if (hit && hit.expires > Date.now()) return hit.profile;

    const profile = must(
      await this.supabase.forUser(club, jwt).from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle(),
    ) as Profile | null;
    if (profile) this.profiles.set(key, { profile, expires: Date.now() + PROFILE_TTL_MS });
    return profile;
  }

  private assertNotBlocked(ip: string): void {
    const f = this.failures.get(ip);
    if (f && f.resetAt > Date.now() && f.count >= FAILED_AUTH_LIMIT) {
      throw new HttpException({ code: 'TOO_MANY_FAILED_ATTEMPTS', message: 'Too many failed attempts' }, 429);
    }
  }

  private reject(ip: string): never {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (!f || f.resetAt <= now) {
      if (this.failures.size > 10_000) this.failures.clear(); // bound memory under a spray of IPs
      this.failures.set(ip, { count: 1, resetAt: now + FAILED_AUTH_WINDOW_MS });
    } else {
      f.count++;
    }
    throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Sign in again' });
  }
}
