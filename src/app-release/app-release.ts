import { CanActivate, ExecutionContext, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { ClubsService } from '../clubs/clubs.module';
import type { Club } from '../clubs/clubs';
import { SupabaseService } from '../supabase/supabase.module';

/** How long a club's minimum is trusted before it is read again. */
const TTL_MS = 60_000;

export interface Release {
  minBuild: number;
  updateUrl: string | null;
}

/**
 * Force update (F-11 / MOB-01). Each club's database holds the lowest app
 * build it still accepts (public.app_release, read through the anon-callable
 * app_release() function), so raising it needs no deploy. Read once a minute
 * per club.
 *
 * Fails open: when the minimum can't be read (the function isn't there yet,
 * the database is down), nobody is told to update. Locking every phone out
 * over a settings read would be worse than one more request from an old build.
 */
@Injectable()
export class AppReleaseService {
  private readonly log = new Logger('AppRelease');
  private readonly cache = new Map<string, Release & { expires: number }>();

  constructor(private readonly supabase: SupabaseService) {}

  async forClub(club: Club, now = Date.now()): Promise<Release> {
    const hit = this.cache.get(club.slug);
    if (hit && hit.expires > now) return hit;
    let release: Release = { minBuild: 0, updateUrl: null };
    try {
      const { data, error } = await this.supabase.forGateway(club).rpc('app_release');
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { min_build?: unknown; update_url?: unknown } | null;
      release = {
        minBuild: Number.isInteger(row?.min_build) ? (row!.min_build as number) : 0,
        updateUrl: typeof row?.update_url === 'string' && row.update_url ? row.update_url : null,
      };
    } catch (e) {
      this.log.warn(`[${club.slug}] minimum app build not read, nobody is held back: ${(e as Error).message}`);
    }
    this.cache.set(club.slug, { ...release, expires: now + TTL_MS });
    return release;
  }
}

/** The app's build number from X-App-Version, or null when it sent none (the portal, older builds). */
export function appBuild(header: string | undefined): number | null {
  if (!header || !/^\d{1,9}$/.test(header.trim())) return null;
  return Number(header.trim());
}

/**
 * Runs before AuthGuard, on every route sign-in included, so an old build is
 * told to update even before it signs in. Only calls that carry X-App-Version
 * (the staff app) are checked; an unknown club is left to AuthGuard.
 * 426 UPGRADE_REQUIRED carries the download link when the club set one. The
 * phone keeps its queued work and shows the Update page.
 */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(
    private readonly clubs: ClubsService,
    private readonly releases: AppReleaseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const build = appBuild(req.header('x-app-version'));
    if (build === null) return true;
    const club = this.clubs.bySlug(req.header('x-club'));
    if (!club) return true;
    const { minBuild, updateUrl } = await this.releases.forClub(club);
    if (build < minBuild) {
      throw new HttpException(
        { code: 'UPGRADE_REQUIRED', message: 'This app version is no longer supported: update the app', minBuild, updateUrl },
        426,
      );
    }
    return true;
  }
}
