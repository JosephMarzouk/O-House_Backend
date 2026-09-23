import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
  ParseUUIDPipe,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SupabaseService } from '../supabase/supabase.module';
import type { CurrentUser } from '../auth/current-user';
import { UpstreamError } from './upstream';

/**
 * The refusal contract the phone's outbox is built on:
 *
 *   422 { refused: true, code, message }  a KNOWN business refusal: park the op,
 *                                         keep its evidence, show it with Retry.
 *   anything else from upstream → 503     retry with backoff; never drop.
 *
 * Only the RPCs' own messages count as refusals. PostgREST also returns
 * 400/403/404/409 for infrastructure faults (a misconfigured gate, a stale
 * schema cache, a constraint or trigger error), and treating those as
 * refusals would let one bad deploy wipe every phone's queue. Over-matching
 * here destroys work; under-matching only makes a phone wait.
 *
 * Messages are the exact strings the RPCs raise (0013_rounds_follow_up.sql),
 * the same list the app's sync.dart matches on.
 */
const REFUSALS: ReadonlyArray<[needle: string, code: string]> = [
  ['ASSIGNMENT_EXPIRED', 'ASSIGNMENT_EXPIRED'],
  ['EMPTY_SUBMISSION', 'EMPTY_SUBMISSION'],
  ['MISSING_PHOTO', 'MISSING_PHOTO'],
  ['INCOMPLETE', 'INCOMPLETE'],
  ['Assignment not found', 'ASSIGNMENT_NOT_FOUND'],
  ['Item not found', 'ITEM_NOT_FOUND'],
  ['Not authorized', 'NOT_AUTHORIZED'],
  ['Assignment is closed', 'ASSIGNMENT_CLOSED'],
  ['Invalid locale', 'INVALID_FIELD'], // set_locale
];

export function classifyRefusal(message: string): string | null {
  for (const [needle, code] of REFUSALS) if (message.includes(needle)) return code;
  return null;
}

/** A refusal the API decides itself: a field the app controls is invalid. The phone parks the op. */
export function refused(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({ refused: true, code, message });
}

/** A uuid in the path of a phone write. Malformed, it can never succeed: refused, not 400 (which retries). */
export const Uuid = new ParseUUIDPipe({ exceptionFactory: () => refused('INVALID_FIELD', 'Not a uuid') });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

type Req = Request & { user?: CurrentUser };

@Injectable()
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  constructor(private readonly supabase: SupabaseService) {}

  catch(e: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Req>();

    // An oversized upload (multer's limit) is the app's to fix, not a fault to retry.
    if (e instanceof HttpException && e.getStatus() === 413) e = refused('FILE_TOO_LARGE', 'File is too large');

    // Our own decisions (401, 403, 404, 429, 422 refused): passed through.
    if (e instanceof HttpException) {
      const body = e.getResponse();
      if (typeof body === 'object' && (body as { refused?: boolean }).refused) {
        this.record(req, body as { code: string; message: string });
      }
      res.status(e.getStatus()).json(typeof body === 'string' ? { code: 'ERROR', message: body } : body);
      return;
    }

    if (e instanceof UpstreamError) {
      const code = classifyRefusal(e.message);
      if (code) {
        this.record(req, { code, message: e.message });
        res.status(422).json({ refused: true, code, message: e.message });
        return;
      }
    }

    // Unrecognised: logged in full here, never shown to the client, and
    // retryable by contract.
    const key = req.header('idempotency-key');
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    this.log.error(`${req.method} ${req.path}${key ? ` [${key}]` : ''}: ${detail}`);
    res.status(503).json({ code: 'UNAVAILABLE', message: 'Temporarily unavailable, retry later' });
  }

  /**
   * Every refusal a phone gets lands in sync_refusals, so a supervisor sees it
   * (SY-10). Written as the user, and fire and forget: the phone parks the op
   * either way, and a failed log must never turn a 422 into a retry.
   */
  private record(req: Req, r: { code: string; message: string }): void {
    const user = req.user;
    if (!user) return;
    const { id, itemId } = (req.params ?? {}) as Record<string, string | undefined>;
    const key = req.header('idempotency-key');
    this.log.warn(`refused ${req.method} ${req.path}${key ? ` [${key}]` : ''}: ${r.code}`);
    void this.supabase
      .forUser(user.club, user.jwt)
      .rpc('record_sync_refusal', {
        p_op: req.path.split('/').pop() || req.path, // answer | photos | submit | locale
        p_code: r.code,
        p_message: r.message,
        p_assignment_id: isUuid(id) ? id : null,
        p_item_id: isUuid(itemId) ? itemId : null,
        p_idempotency_key: isUuid(key) ? key : null,
      })
      .then(
        ({ error }) => error && this.log.warn(`record_sync_refusal: ${error.message}`),
        (err: unknown) => this.log.warn(`record_sync_refusal: ${String(err)}`),
      );
  }
}
