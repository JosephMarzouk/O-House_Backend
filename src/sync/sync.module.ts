import { Body, Controller, Headers, HttpCode, Module, Post } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.module';
import { CurrentUser, User } from '../auth/current-user';
import { must } from '../common/upstream';
import { isUuid, refused } from '../common/errors.filter';

const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 60;
const uuidOrNull = (v: unknown): string | null => (isUuid(v) ? v : null);

@Controller('sync')
export class SyncController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * SY-6: a refusal the phone decided itself, e.g. MISSING_FILE when the OS
   * purged a photo before it was sent. The API's own 422s are recorded by the
   * errors filter; this is the only other way into sync_refusals.
   */
  @Post('refusals')
  @HttpCode(204)
  async record(
    @User() user: CurrentUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: { op?: unknown; code?: unknown; message?: unknown; assignmentId?: unknown; itemId?: unknown },
  ) {
    if (!short(body?.op) || !short(body.code)) throw refused('INVALID_FIELD', 'op and code are required');
    must(
      await this.supabase.forUser(user.club, user.jwt).rpc('record_sync_refusal', {
        p_op: body.op,
        p_code: body.code,
        p_message: typeof body.message === 'string' ? body.message : null,
        p_assignment_id: uuidOrNull(body.assignmentId),
        p_item_id: uuidOrNull(body.itemId),
        p_idempotency_key: uuidOrNull(key),
      }),
    );
  }
}

@Module({ controllers: [SyncController] })
export class SyncModule {}
