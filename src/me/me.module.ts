import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Put } from '@nestjs/common';
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

  /**
   * The phone's FCM token (PN-1). Sent after sign-in and whenever Firebase
   * rotates it; idempotent. A token belongs to one user at a time: on a
   * shared phone the next person's sign-in takes it over (register_device_token
   * is SECURITY DEFINER for exactly that).
   */
  @Put('devices')
  @HttpCode(204)
  async registerDevice(@User() user: CurrentUser, @Body('token') token: unknown, @Body('platform') platform: unknown) {
    if (typeof token !== 'string' || !token.trim()) throw refused('INVALID_FIELD', 'token must be text');
    if (platform !== 'android' && platform !== 'ios') throw refused('INVALID_FIELD', 'platform must be android or ios');
    must(await this.supabase.forUser(user.club, user.jwt).rpc('register_device_token', { p_token: token, p_platform: platform }));
  }

  /** At sign-out, before the session goes. Only the caller's own token is removed; anything else is a no-op. */
  @Delete('devices/:token')
  @HttpCode(204)
  async unregisterDevice(@User() user: CurrentUser, @Param('token') token: string) {
    must(await this.supabase.forUser(user.club, user.jwt).rpc('unregister_device_token', { p_token: token }));
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
