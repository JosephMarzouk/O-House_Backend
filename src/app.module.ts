import { Injectable, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClubsModule } from './clubs/clubs.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { MeModule } from './me/me.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { HealthController } from './health/health.controller';
import { SyncModule } from './sync/sync.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportMailModule } from './reports/report-mail.module';
import { ErrorsFilter } from './common/errors.filter';
import { parseLogin } from './auth/logins';
import { AppReleaseService, AppVersionGuard } from './app-release/app-release';

/**
 * Runs after AuthGuard, so it counts per club and user. That matters: a
 * whole club's phones share one Wi-Fi IP, and an IP limit would throttle a
 * shift's worth of reconnecting phones as one caller.
 *
 * Sign-in has no user yet, so it counts per IP *and* login (F-07): the club's
 * Wi-Fi, and the portal server (every portal sign-in arrives from its IP),
 * are one address for many people, so an IP-only limit refused the 11th
 * person of the minute. The per-account lock (10 wrong passwords, 15 min, in
 * the database) still stops guessing one account from many IPs.
 * ponytail: no IP-wide cap on sign-in, so spraying one password across many
 * logins from one IP is bounded only by each account's lock; add a second,
 * looser IP throttler if the clubs grow past a few hundred staff.
 * Other public routes (refresh, logout) fall back to the IP.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req.user) return `${req.user.club.slug}:${req.user.id}`;
    const login = parseLogin(req.body?.login);
    // The normalized login, so "0101…" and "+20101…" count as one.
    return login ? `${req.ip}:${'phone' in login ? login.phone : login.email}` : req.ip;
  }
}

@Module({
  imports: [
    // 600/min per user: a phone reconnecting after a shift offline drains
    // dozens of ops in seconds, and that must never trip the limit.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    ClubsModule,
    SupabaseModule,
    AuthModule,
    MeModule,
    AssignmentsModule,
    SyncModule,
    NotificationsModule, // the push worker; idle for a club without a Firebase key
    ReportMailModule, // the report emails; idle for a club without `mail`
  ],
  controllers: [HealthController],
  providers: [
    AppReleaseService,
    { provide: APP_GUARD, useClass: AppVersionGuard }, // an old app build hears "update" before anything else
    { provide: APP_GUARD, useClass: AuthGuard }, // order matters: auth before the throttler
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter }, // the refusal contract; records refusals
  ],
})
export class AppModule {}
