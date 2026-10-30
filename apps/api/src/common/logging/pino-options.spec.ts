import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { buildLoggerOptions } from './pino-options';

/** Only `NODE_ENV` is read, and only to choose pretty-printing. */
const configFor = (nodeEnv: string) =>
  ({ get: () => nodeEnv }) as unknown as ConfigService<Env, true>;

type LevelFn = (
  req: unknown,
  res: { statusCode: number },
  err?: Error,
) => string;

const levelFor = (statusCode: number, err?: Error): string => {
  const options = buildLoggerOptions(configFor('test'));
  const customLogLevel = options.pinoHttp as { customLogLevel: LevelFn };
  return customLogLevel.customLogLevel({}, { statusCode }, err);
};

describe('buildLoggerOptions', () => {
  describe('customLogLevel', () => {
    it('reports a successful response at info', () => {
      expect(levelFor(200)).toBe('info');
    });

    it('reports a client mistake at warn', () => {
      expect(levelFor(422)).toBe('warn');
    });

    it('reports a server fault at error', () => {
      expect(levelFor(500)).toBe('error');
    });

    it('reports an unhandled throw at error whatever the status says', () => {
      expect(levelFor(200, new Error('boom'))).toBe('error');
    });

    /**
     * The half of the decision that lives here rather than in the exception
     * filter. Both have to agree, or an outage still shows up as `error` on
     * the request line even while the filter is calling it a warning — and
     * severity is what alerting reads.
     */
    it('reports a dependency being unavailable at warn, not as a fault', () => {
      expect(levelFor(503)).toBe('warn');
    });

    it('still reports a 502 or 504 as a fault, being nothing we chose', () => {
      expect(levelFor(502)).toBe('error');
      expect(levelFor(504)).toBe('error');
    });
  });
});
