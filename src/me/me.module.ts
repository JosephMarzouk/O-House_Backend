import { Body, Controller, Get, HttpCode, Module, Patch } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.module';
import { CurrentUser, PROFILE_COLUMNS, User } from '../auth/current-user';
import { must } from '../common/upstream';
import { refused } from '../common/errors.filter';

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
   */
  @Get()
  async me(@User() user: CurrentUser) {
    const db = this.supabase.forUser(user.club, user.jwt);
    const [profile, pages] = await Promise.all([
      db.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).single().then(must),
      db.from('club_pages').select('key, body_en, body_ar').then(must),
    ]);
    return {
      profile,
      club: { slug: user.club.slug, name: user.club.name, logoUrl: user.club.logoUrl },
      pages,
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
