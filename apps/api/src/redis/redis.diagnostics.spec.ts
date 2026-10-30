import { EventEmitter } from 'node:events';
import {
  attachRedisDiagnostics,
  REDIS_ERROR_LOG_INTERVAL_MS,
} from './redis.diagnostics';

/** ioredis emits one of these per failed reconnect attempt — several per second. */
const CONNECT_REFUSED = 'connect ECONNREFUSED 127.0.0.1:6379';

describe('attachRedisDiagnostics', () => {
  let client: EventEmitter;
  let logger: { log: jest.Mock; error: jest.Mock };

  const fail = (message = CONNECT_REFUSED): void => {
    client.emit('error', new Error(message));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    client = new EventEmitter();
    logger = { log: jest.fn(), error: jest.fn() };
    attachRedisDiagnostics(client, logger);
  });

  afterEach(() => jest.useRealTimers());

  it('logs the first error immediately, through the logger', () => {
    fail();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(CONNECT_REFUSED),
    );
  });

  describe('when the error carries no message of its own', () => {
    /**
     * What ioredis actually emits for a refused connection — verified against a
     * live boot: an AggregateError whose own `message` is empty, with the real
     * causes in `errors`. Reading `err.message` renders "connection error: "
     * and tells the operator nothing.
     */
    const refusedAggregate = (): Error =>
      new AggregateError([new Error(CONNECT_REFUSED)], '');

    it('falls back to the aggregated causes', () => {
      client.emit('error', refusedAggregate());

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(CONNECT_REFUSED),
      );
    });

    it('collapses repeated causes instead of repeating one line per address', () => {
      client.emit(
        'error',
        new AggregateError(
          [new Error(CONNECT_REFUSED), new Error(CONNECT_REFUSED)],
          '',
        ),
      );

      const [message] = logger.error.mock.calls[0] as [string];
      expect(message.match(/ECONNREFUSED/g)).toHaveLength(1);
    });

    it('still names something when there are no causes at all', () => {
      client.emit('error', new AggregateError([], ''));

      const [message] = logger.error.mock.calls[0] as [string];
      expect(message).toMatch(/Redis connection error: \S/);
    });
  });

  it('stays quiet for a burst of errors inside the throttle window', () => {
    fail();
    for (let i = 0; i < 50; i += 1) {
      jest.advanceTimersByTime(100);
      fail();
    }

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs again after the window, reporting what it suppressed', () => {
    fail();
    fail();
    fail();
    fail();
    jest.advanceTimersByTime(REDIS_ERROR_LOG_INTERVAL_MS);
    fail();

    expect(logger.error).toHaveBeenCalledTimes(2);
    const [second] = logger.error.mock.calls[1] as [string];
    expect(second).toContain('suppressed since the last log: 3');
  });

  it('keeps log volume bounded through a long outage', () => {
    // Two minutes of ioredis retrying five times a second.
    for (let i = 0; i < 600; i += 1) {
      fail();
      jest.advanceTimersByTime(200);
    }

    expect(logger.error.mock.calls.length).toBeLessThanOrEqual(
      120_000 / REDIS_ERROR_LOG_INTERVAL_MS + 1,
    );
  });

  it('logs recovery when the client reconnects', () => {
    fail();
    fail();
    jest.advanceTimersByTime(5000);
    client.emit('ready');

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [recovery] = logger.log.mock.calls[0] as [string];
    expect(recovery).toContain('recovered after 5s');
    expect(recovery).toContain('errors during the outage: 2');
  });

  it('says nothing on the ready event of a healthy startup', () => {
    client.emit('ready');

    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a new outage immediately even if it follows a recovery closely', () => {
    fail();
    jest.advanceTimersByTime(1000);
    client.emit('ready');
    jest.advanceTimersByTime(1000);
    fail();

    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
