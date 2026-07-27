import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { z } from 'zod';
import { AppException } from '../errors/app.exception';
import type { ProblemDetails } from '../errors/problem-details';
import { AllExceptionsFilter } from './all-exceptions.filter';

const REQUEST_ID = 'req-test-1';

class OrderInvalidTransitionError extends AppException {
  constructor(from: string, to: string) {
    super({
      code: 'ORDER_INVALID_TRANSITION',
      status: 409,
      title: 'Invalid order transition',
      detail: `Order is ${from}; cannot transition to ${to}.`,
      meta: { currentStatus: from, requested: to },
    });
  }
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let reply: jest.Mock;
  let host: ArgumentsHost;
  let logError: jest.SpyInstance;

  /** Runs the filter and returns the envelope it handed to the HTTP adapter. */
  function capture(exception: unknown): {
    problem: ProblemDetails;
    status: number;
  } {
    filter.catch(exception, host);
    const [, problem, status] = reply.mock.calls[0] as [
      unknown,
      ProblemDetails,
      number,
    ];
    return { problem, status };
  }

  beforeEach(() => {
    reply = jest.fn();
    const adapterHost = {
      httpAdapter: { reply },
    } as unknown as HttpAdapterHost;
    filter = new AllExceptionsFilter(adapterHost);

    const req = { id: REQUEST_ID, method: 'POST', url: '/api/v1/orders' };
    host = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as unknown as ArgumentsHost;

    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('replies with the status the envelope declares', () => {
    const { problem, status } = capture(
      new OrderInvalidTransitionError('READY', 'IN_PREPARATION'),
    );

    expect(status).toBe(409);
    expect(problem.status).toBe(409);
  });

  it('maps a domain exception to its full envelope', () => {
    const { problem } = capture(
      new OrderInvalidTransitionError('READY', 'IN_PREPARATION'),
    );

    expect(problem).toEqual({
      type: 'https://cafepos.dev/errors/order-invalid-transition',
      title: 'Invalid order transition',
      status: 409,
      code: 'ORDER_INVALID_TRANSITION',
      detail: 'Order is READY; cannot transition to IN_PREPARATION.',
      requestId: REQUEST_ID,
      errors: null,
      meta: { currentStatus: 'READY', requested: 'IN_PREPARATION' },
    });
  });

  it('turns a ZodError into 422 with one entry per offending field', () => {
    const schema = z.object({ name: z.string(), quantity: z.number().max(50) });
    const parsed = schema.safeParse({ name: 123, quantity: 999 });

    const { problem } = capture(parsed.error);

    expect(problem.status).toBe(422);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.field)).toEqual(
      expect.arrayContaining(['name', 'quantity']),
    );
  });

  it('maps a framework 404 to RESOURCE_NOT_FOUND', () => {
    const { problem } = capture(new NotFoundException('Cannot GET /nope'));

    expect(problem.code).toBe('RESOURCE_NOT_FOUND');
    expect(problem.detail).toBe('Cannot GET /nope');
  });

  it('flattens a multi-message HttpException into one detail string', () => {
    const { problem } = capture(
      new BadRequestException(['name required', 'quantity too large']),
    );

    expect(problem.detail).toBe('name required; quantity too large');
  });

  it('never leaks the message of a 5xx HttpException', () => {
    const { problem } = capture(
      new InternalServerErrorException(
        'pg: password authentication failed for user "cafepos"',
      ),
    );

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL');
    expect(problem.detail).toBe('An unexpected error occurred.');
  });

  it('reports an unknown throw as INTERNAL with nothing leaked', () => {
    const { problem } = capture(new Error('connection string: postgres://...'));

    expect(problem).toMatchObject({
      status: 500,
      code: 'INTERNAL',
      detail: 'An unexpected error occurred.',
      requestId: REQUEST_ID,
    });
  });

  describe('middleware errors that carry an HTTP status', () => {
    /** Shape body-parser throws for an oversized body. */
    function payloadTooLarge(): Error {
      return Object.assign(new Error('request entity too large'), {
        status: 413,
        statusCode: 413,
        type: 'entity.too.large',
      });
    }

    it('honours a 4xx status instead of reporting a server error', () => {
      const { problem, status } = capture(payloadTooLarge());

      expect(status).toBe(413);
      expect(problem.status).toBe(413);
      expect(problem.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('does not log a client mistake as a server error', () => {
      capture(payloadTooLarge());

      expect(logError).not.toHaveBeenCalled();
    });

    it('still treats a 5xx-carrying error as INTERNAL', () => {
      const upstream = Object.assign(new Error('socket hang up'), {
        statusCode: 502,
      });

      const { problem } = capture(upstream);

      expect(problem.status).toBe(500);
      expect(problem.code).toBe('INTERNAL');
    });

    it('truncates an over-long detail rather than echoing it whole', () => {
      const noisy = Object.assign(new Error('x'.repeat(500)), {
        statusCode: 400,
      });

      const { problem } = capture(noisy);

      expect(problem.detail.length).toBeLessThanOrEqual(200);
    });
  });

  describe('logging', () => {
    it('logs 5xx with the stack so a human can investigate', () => {
      const boom = new Error('boom');

      capture(boom);

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(REQUEST_ID),
        boom.stack,
      );
    });

    it('stays quiet for handled 4xx', () => {
      capture(new NotFoundException());

      expect(logError).not.toHaveBeenCalled();
    });
  });

  it('falls back to "unknown" when no request id was attached', () => {
    host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/' }),
        getResponse: () => ({}),
      }),
    } as unknown as ArgumentsHost;

    const { problem } = capture(new NotFoundException());

    expect(problem.requestId).toBe('unknown');
  });

  it('derives the type URI from the code', () => {
    const { problem } = capture(
      new HttpException('nope', HttpStatus.TOO_MANY_REQUESTS),
    );

    expect(problem.type).toBe('https://cafepos.dev/errors/rate-limited');
  });
});
