import { Injectable, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClubsModule } from './clubs/clubs.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthGuard } from './auth/auth.guard';
import { MeModule } from './me/me.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { HealthController } from './health/health.controller';
import { SyncModule } from './sync/sync.module';
import { ErrorsFilter } from './common/errors.filter';

/**
 * Runs after AuthGuard, so it counts per club and user. That matters: a
 * whole club's phones share one Wi-Fi IP, and an IP limit would throttle a
 * shift's worth of reconnecting phones as one caller. Public routes fall
 * back to the IP.
 */
@Injectable()
class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user ? `${req.user.club.slug}:${req.user.id}` : req.ip;
  }
}

@Module({
  imports: [
    // 600/min per user: a phone reconnecting after a shift offline drains
    // dozens of ops in seconds, and that must never trip the limit.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    ClubsModule,
    SupabaseModule,
    MeModule,
    AssignmentsModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard }, // order matters: auth first
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter }, // the refusal contract; records refusals
  ],
})
export class AppModule {}
