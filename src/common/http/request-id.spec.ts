import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateRequestId, getRequestId } from './request-id';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeReq(inbound?: string | string[]): IncomingMessage {
  const headers: Record<string, string | string[]> = {};
  if (inbound !== undefined) headers['x-request-id'] = inbound;
  return { headers } as unknown as IncomingMessage;
}

/** Returns the stub response plus a standalone handle to its spy, so assertions
 *  never reference the method through its typed interface (unbound-method). */
function makeRes(): { res: ServerResponse; setHeader: jest.Mock } {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as ServerResponse, setHeader };
}

describe('generateRequestId', () => {
  it('mints a UUID when no inbound header is present', () => {
    const { res, setHeader } = makeRes();
    const id = generateRequestId(makeReq(), res);

    expect(id).toMatch(UUID_RE);
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', id);
  });

  it('reuses a well-formed inbound id so proxy correlation survives', () => {
    const { res, setHeader } = makeRes();
    const id = generateRequestId(makeReq('abc-123_XYZ.9'), res);

    expect(id).toBe('abc-123_XYZ.9');
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123_XYZ.9');
  });

  it('takes the first value when the header is repeated', () => {
    const id = generateRequestId(
      makeReq(['first-id', 'second-id']),
      makeRes().res,
    );

    expect(id).toBe('first-id');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a newline (log forging)', 'abc\nlevel=error fake'],
    ['a carriage return', 'abc\r\nInjected: header'],
    ['spaces', 'not a valid id'],
    ['non-ascii', 'idé-123'],
    ['a semicolon', 'abc;drop'],
  ])('falls back to a UUID when the inbound id contains %s', (_label, bad) => {
    const id = generateRequestId(makeReq(bad), makeRes().res);

    expect(id).toMatch(UUID_RE);
  });

  it('falls back to a UUID when the inbound id exceeds the length cap', () => {
    const id = generateRequestId(makeReq('a'.repeat(129)), makeRes().res);

    expect(id).toMatch(UUID_RE);
  });

  it('accepts an inbound id exactly at the length cap', () => {
    const atCap = 'a'.repeat(128);
    const id = generateRequestId(makeReq(atCap), makeRes().res);

    expect(id).toBe(atCap);
  });

  it('never echoes an untrusted value back on the response header', () => {
    const { res, setHeader } = makeRes();
    generateRequestId(makeReq('bad\r\nX-Admin: true'), res);

    const [, echoed] = setHeader.mock.calls[0] as [string, string];
    expect(echoed).toMatch(UUID_RE);
  });
});

describe('getRequestId', () => {
  it('reads the id off a request', () => {
    expect(getRequestId({ id: 'req-1' })).toBe('req-1');
  });

  it('falls back to "unknown" when absent', () => {
    expect(getRequestId(undefined)).toBe('unknown');
    expect(getRequestId({})).toBe('unknown');
  });
});
