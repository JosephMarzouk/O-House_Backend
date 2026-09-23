import { ForbiddenException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { classifyRefusal, ErrorsFilter, refused } from './errors.filter';
import { UpstreamError } from './upstream';

const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const I1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const K1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function run(e: unknown, user: unknown = { club: {}, jwt: 't' }) {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const req: any = {
    method: 'POST',
    path: `/assignments/${A1}/items/${I1}/photos`,
    params: { id: A1, itemId: I1 },
    user,
    header: (h: string) => (h === 'idempotency-key' ? K1 : undefined),
  };
  const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  const rpc = jest.fn(async () => ({ error: null }));
  jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
  new ErrorsFilter({ forUser: () => ({ rpc }) } as any).catch(e, host);
  const out = { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  return Object.defineProperty(out, 'rpc', { value: rpc }) as typeof out & { rpc: typeof rpc }; // not enumerable: toEqual ignores it
}

describe('classifyRefusal', () => {
  it.each([
    ['ASSIGNMENT_EXPIRED: window closed at 14:00', 'ASSIGNMENT_EXPIRED'],
    ['P0001: MISSING_PHOTO: item 3 needs a photo', 'MISSING_PHOTO'],
    ['EMPTY_SUBMISSION', 'EMPTY_SUBMISSION'],
    ['Item not found', 'ITEM_NOT_FOUND'],
    ['Not authorized', 'NOT_AUTHORIZED'],
    ['Assignment is closed', 'ASSIGNMENT_CLOSED'],
  ])('%s is a refusal', (message, code) => expect(classifyRefusal(message)).toBe(code));

  it.each([
    'permission denied for function mark_item_done', // a revoked grant, not a business rule
    'Could not find the function public.mark_item_done in the schema cache', // mid-migration
    'duplicate key value violates unique constraint', // a bug, not the user's fault
    'Direct Data API access is disabled', // the gate, misconfigured
    'fetch failed',
  ])('%s is NOT a refusal', (message) => expect(classifyRefusal(message)).toBeNull());
});

describe('ErrorsFilter: the phone never drops work over an infrastructure fault', () => {
  it('a known business refusal → 422 refused', () => {
    expect(run(new UpstreamError('ASSIGNMENT_EXPIRED: closed'))).toEqual({
      status: 422,
      body: { refused: true, code: 'ASSIGNMENT_EXPIRED', message: 'ASSIGNMENT_EXPIRED: closed' },
    });
  });

  it('an unrecognised upstream error → 503, and never refused', () => {
    const { status, body } = run(new UpstreamError('permission denied for table profiles', '42501'));
    expect(status).toBe(503);
    expect(body.refused).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('profiles'); // internals stay in the log
  });

  it('a crash → 503', () => {
    expect(run(new TypeError('x is undefined')).status).toBe(503);
  });

  it('our own HTTP decisions pass through', () => {
    expect(run(new ForbiddenException({ code: 'NO_ACCESS', message: 'no' }))).toEqual({
      status: 403,
      body: { code: 'NO_ACCESS', message: 'no' },
    });
    expect(run(new HttpException('slow down', 429)).status).toBe(429);
  });
});

describe('ErrorsFilter: every refusal is recorded for the supervisor (SY-10)', () => {
  it('an RPC refusal is written to sync_refusals as the user, with the ids from the path', () => {
    const { rpc } = run(new UpstreamError('ASSIGNMENT_EXPIRED'));
    expect(rpc).toHaveBeenCalledWith('record_sync_refusal', {
      p_op: 'photos',
      p_code: 'ASSIGNMENT_EXPIRED',
      p_message: 'ASSIGNMENT_EXPIRED',
      p_assignment_id: A1,
      p_item_id: I1,
      p_idempotency_key: K1,
    });
  });

  it('so is one the API decides itself', () => {
    const { status, rpc } = run(refused('INVALID_FILE', 'Expected a JPEG file'));
    expect(status).toBe(422);
    expect(rpc).toHaveBeenCalledWith('record_sync_refusal', expect.objectContaining({ p_code: 'INVALID_FILE' }));
  });

  it('an oversized upload is refused, not retried forever', () => {
    expect(run(new PayloadTooLargeException()).body).toEqual({
      refused: true,
      code: 'FILE_TOO_LARGE',
      message: 'File is too large',
    });
  });

  it('a 503 and an unauthenticated refusal record nothing', () => {
    expect(run(new UpstreamError('fetch failed')).rpc).not.toHaveBeenCalled();
    expect(run(new UpstreamError('Not authorized'), null).rpc).not.toHaveBeenCalled();
  });
});
