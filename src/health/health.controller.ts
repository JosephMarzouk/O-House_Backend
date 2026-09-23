import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  /** Railway's health check. Boot already failed if the club registry is invalid. */
  @Public()
  @SkipThrottle()
  @Get()
  health() {
    return { status: 'ok' };
  }
}
