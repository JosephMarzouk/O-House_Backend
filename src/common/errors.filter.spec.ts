import { ForbiddenException, HttpException } from '@nestjs/common';
import { classifyRefusal, ErrorsFilter } from './errors.filter';
import { UpstreamError } from './upstream';

function run(e: unknown) {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const host: any = { switchToHttp: () => ({ getResponse: () => res }) };
  jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  new ErrorsFilter().catch(e, host);
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
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
