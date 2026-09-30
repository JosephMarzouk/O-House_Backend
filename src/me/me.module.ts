import { Body, Controller, Get, HttpCode, Module, Patch } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.module';
import { CurrentUser, PROFILE_COLUMNS, User } from '../auth/current-user';
import { must } from '../common/upstream';
import { refused } from '../common/errors.filter';

type LocationRow = { lat: number | string; lng: number | string; radius_m: number };

/** The club_location row as the app reads it; null until an admin sets it. numeric may arrive as text. */
export function clubLocation(row: LocationRow | null) {
  return row ? { lat: Number(row.lat), lng: Number(row.lng), radiusM: Number(row.radius_m) } : null;
}

@Controller('me')
export class MeController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Read fresh, not from the guard's 60 s cache, so a locale or role change
   * shows at once.
   *
   * No phone: phone is meant to be admin-only (0011). The app shows the
   * signed-in user's own number from their sign-in identity instead.
   *
   * `pages` is the club's About and Policies text (club_pages, written by an
   * admin in the portal). It rides on /me because the app caches it at the
   * same moment as the profile, so Profile shows it offline too.
   *
   * `location` is the club's zone (club_location, set once by an admin). The
   * app caches it the same way and keeps checklists closed outside it.
   *
   * `access` is my_access(): the role (with its name in both languages), scope
   * and permissions the caller's role grants; null when the database finds no
   * active role. `profile.role` stays for app builds that predate custom roles.
   */
  @Get()
  async me(@User() user: CurrentUser) {
    const db = this.supabase.forUser(user.club, user.jwt);
    const [profile, pages, location, access] = await Promise.all([
      db.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).single().then(must),
      db.from('club_pages').select('key, body_en, body_ar').then(must),
      db.from('club_location').select('lat, lng, radius_m').maybeSingle<LocationRow>().then(must),
      db.rpc('my_access').then(must),
    ]);
    return {
      profile,
      club: { slug: user.club.slug, name: user.club.name, logoUrl: user.club.logoUrl },
      pages,
      location: clubLocation(location),
      access: access ?? null,
    };
  }

  /** set_locale validates the value; its 'Invalid locale' is a refusal. */
  @Patch('locale')
  @HttpCode(204)
  async locale(@User() user: CurrentUser, @Body('locale') locale: unknown) {
    if (typeof locale !== 'string') throw refused('INVALID_FIELD', 'locale must be text');
    must(await this.supabase.forUser(user.club, user.jwt).rpc('set_locale', { p_locale: locale }));
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
