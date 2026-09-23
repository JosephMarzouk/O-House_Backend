import { Controller, Get, Global, Injectable, Module, NotFoundException, Param } from '@nestjs/common';
import { Club, clubForHost, parseClubs, PublicClub, toPublic } from './clubs';
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

  byHost(host: string): Club | undefined {
    return clubForHost(this.bySlugMap.values(), host, process.env.PORTAL_DOMAIN);
  }

}

@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

  /** The portal: which club a request's host belongs to (ohouse.<PORTAL_DOMAIN>, or a club's own domain). */
  @Public()
  @Get('host/:host')
  byHost(@Param('host') host: string): PublicClub {
    const club = this.clubs.byHost(host);
    if (!club) throw new NotFoundException({ code: 'UNKNOWN_CLUB', message: 'No club at this address' });
    return toPublic(club);
  }

}

@Global()
@Module({ providers: [ClubsService], controllers: [ClubsController], exports: [ClubsService] })
export class ClubsModule {}
