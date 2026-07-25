import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE } from '../database/drizzle.constants';
import { REDIS } from '../redis/redis.constants';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  let db: { execute: jest.Mock };
  let redis: { ping: jest.Mock };

  beforeEach(async () => {
    db = { execute: jest.fn().mockResolvedValue(undefined) };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DRIZZLE, useValue: db },
        { provide: REDIS, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(HealthService);
  });

  it('reports ok when both dependencies answer', async () => {
    const result = await service.checkReadiness();

    expect(result).toEqual({
      ok: true,
      checks: { db: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('probes both dependencies in parallel, not in series', async () => {
    let dbSettled = false;
    db.execute.mockImplementation(
      () =>
        new Promise((resolve) =>
          setImmediate(() => {
            dbSettled = true;
            resolve(undefined);
          }),
        ),
    );
    redis.ping.mockImplementation(() => {
      // Redis is probed before the DB probe has settled => they overlap.
      expect(dbSettled).toBe(false);
      return Promise.resolve('PONG');
    });

    await service.checkReadiness();

    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('reports not-ok and surfaces the reason when the DB is down', async () => {
    db.execute.mockRejectedValue(new Error('connection refused'));

    const result = await service.checkReadiness();

    expect(result.ok).toBe(false);
    expect(result.checks.db).toEqual({
      status: 'down',
      error: 'connection refused',
    });
    expect(result.checks.redis.status).toBe('up');
  });

  it('reports not-ok when Redis rejects', async () => {
    redis.ping.mockRejectedValue(new Error('ECONNRESET'));

    const result = await service.checkReadiness();

    expect(result.ok).toBe(false);
    expect(result.checks.redis).toEqual({
      status: 'down',
      error: 'ECONNRESET',
    });
    expect(result.checks.db.status).toBe('up');
  });

  it('treats an unexpected Redis reply as down', async () => {
    redis.ping.mockResolvedValue('WEIRD');

    const result = await service.checkReadiness();

    expect(result.ok).toBe(false);
    expect(result.checks.redis).toEqual({
      status: 'down',
      error: 'unexpected ping reply',
    });
  });

  it('reports not-ok when both dependencies are down', async () => {
    db.execute.mockRejectedValue(new Error('db gone'));
    redis.ping.mockRejectedValue(new Error('redis gone'));

    const result = await service.checkReadiness();

    expect(result.ok).toBe(false);
    expect(result.checks.db.status).toBe('down');
    expect(result.checks.redis.status).toBe('down');
  });

  describe('when a dependency wedges', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('times out a hung DB probe rather than hanging readiness', async () => {
      db.execute.mockReturnValue(new Promise(() => {}));

      const pending = service.checkReadiness();
      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.checks.db.status).toBe('down');
      expect(result.checks.db.error).toMatch(/db check timed out after 2000ms/);
    });

    it('times out a hung Redis probe', async () => {
      redis.ping.mockReturnValue(new Promise(() => {}));

      const pending = service.checkReadiness();
      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.checks.redis.error).toMatch(
        /redis check timed out after 2000ms/,
      );
    });
  });
});
