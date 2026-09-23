import { Controller, Get, Module } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.module';
import { CurrentUser, PROFILE_COLUMNS, User } from '../auth/current-user';
import { must } from '../common/upstream';

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
}

@Module({ controllers: [MeController] })
export class MeModule {}
