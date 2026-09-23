import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
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
];

export function classifyRefusal(message: string): string | null {
  for (const [needle, code] of REFUSALS) if (message.includes(needle)) return code;
  return null;
}

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // Our own decisions (401, 403, 404, 429, 422 validation): passed through.
    if (e instanceof HttpException) {
      const body = e.getResponse();
      res.status(e.getStatus()).json(typeof body === 'string' ? { code: 'ERROR', message: body } : body);
      return;
    }

    if (e instanceof UpstreamError) {
      const code = classifyRefusal(e.message);
      if (code) {
        res.status(422).json({ refused: true, code, message: e.message });
        return;
      }
    }

    // Unrecognised: logged in full here, never shown to the client, and
    // retryable by contract.
    this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    res.status(503).json({ code: 'UNAVAILABLE', message: 'Temporarily unavailable, retry later' });
  }
}
