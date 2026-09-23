import { Body, Controller, Get, HttpCode, Module, Patch, Post } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.module';
import { CurrentUser, PROFILE_COLUMNS, User } from '../auth/current-user';
import { must } from '../common/upstream';
import { refused } from '../common/errors.filter';

@Controller('me')
export class MeController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Read fresh, not from the guard's 60 s cache: the app routes on
   * must_change_password right after a change, and a stale true would loop it
   * back to the set-password screen.
   *
   * No phone: phone is meant to be admin-only (0011). The app shows the
   * signed-in user's own number from their sign-in identity instead.
   */
  @Get()
  async me(@User() user: CurrentUser) {
    const profile = must(
      await this.supabase
        .forUser(user.club, user.jwt)
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', user.id)
        .single(),
    );
    return { profile, club: { slug: user.club.slug, name: user.club.name, logoUrl: user.club.logoUrl } };
  }

  /** set_locale validates the value; its 'Invalid locale' is a refusal. */
  @Patch('locale')
  @HttpCode(204)
  async locale(@User() user: CurrentUser, @Body('locale') locale: unknown) {
    if (typeof locale !== 'string') throw refused('INVALID_FIELD', 'locale must be text');
    must(await this.supabase.forUser(user.club, user.jwt).rpc('set_locale', { p_locale: locale }));
  }

  /** Called after the Auth password update succeeds: clears must_change_password. */
  @Post('password-changed')
  @HttpCode(204)
  async passwordChanged(@User() user: CurrentUser) {
    must(await this.supabase.forUser(user.club, user.jwt).rpc('complete_password_change'));
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
