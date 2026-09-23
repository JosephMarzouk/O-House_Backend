import { Controller, Get, Global, Injectable, Module, NotFoundException, Param } from '@nestjs/common';
import { Club, parseClubs, PublicClub, toPublic } from './clubs';
import { Public } from '../auth/public.decorator';

@Injectable()
export class ClubsService {
  private readonly bySlugMap = parseClubs(process.env.CLUBS);

  bySlug(slug: string | undefined): Club | undefined {
    return slug ? this.bySlugMap.get(slug) : undefined;
  }

  all(): Club[] {
    return [...this.bySlugMap.values()];
  }

  byCode(code: string): Club | undefined {
    const wanted = code.toUpperCase();
    for (const c of this.bySlugMap.values()) if (c.code === wanted) return c;
    return undefined;
  }
}

@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

  /** First launch of the app: a club code becomes that club's connection details and branding. */
  @Public()
  @Get(':code')
  get(@Param('code') code: string): PublicClub {
    const club = this.clubs.byCode(code);
    if (!club) throw new NotFoundException({ code: 'UNKNOWN_CLUB', message: 'No club with that code' });
    return toPublic(club);
  }
}

@Global()
@Module({ providers: [ClubsService], controllers: [ClubsController], exports: [ClubsService] })
export class ClubsModule {}
