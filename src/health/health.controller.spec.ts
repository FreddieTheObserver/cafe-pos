import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import type { ReadinessResult } from './health.service';

const UP = { status: 'up' } as const;
const DOWN = { status: 'down', error: 'connection refused' } as const;

/** Returns the stub response plus a standalone handle to its spy, so assertions
 *  never reference the method through its typed interface (unbound-method). */
function makeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  const res = { status };
  status.mockReturnValue(res);
  return { res: res as unknown as Response, status };
}

describe('HealthController', () => {
  let controller: HealthController;
  let checkReadiness: jest.Mock;

  const givenReadiness = (result: ReadinessResult) =>
    checkReadiness.mockResolvedValue(result);

  beforeEach(async () => {
    checkReadiness = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { checkReadiness } }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  describe('liveness', () => {
    it('reports ok without touching dependencies', () => {
      expect(controller.liveness()).toEqual({ status: 'ok' });
      expect(checkReadiness).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('answers 200 with per-dependency detail when everything is up', async () => {
      givenReadiness({ ok: true, checks: { db: UP, redis: UP } });
      const { res, status } = makeRes();

      const body = await controller.readiness(res);

      expect(status).toHaveBeenCalledWith(200);
      expect(body).toEqual({ status: 'ok', checks: { db: UP, redis: UP } });
    });

    it('answers 503 when a dependency is down', async () => {
      givenReadiness({ ok: false, checks: { db: DOWN, redis: UP } });
      const { res, status } = makeRes();

      const body = await controller.readiness(res);

      expect(status).toHaveBeenCalledWith(503);
      expect(body).toEqual({
        status: 'unavailable',
        checks: { db: DOWN, redis: UP },
      });
    });

    it('surfaces the failing dependency so operators can triage', async () => {
      givenReadiness({ ok: false, checks: { db: UP, redis: DOWN } });

      const body = await controller.readiness(makeRes().res);

      expect(body.checks.redis.error).toBe('connection refused');
    });
  });
});
