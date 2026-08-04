import { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import { Env } from '../../config/env.validation';
import { generateRequestId } from '../http/request-id';

const SILENT_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Builds nestjs-pino options from config. Dev gets pretty single-line logs;
 * prod emits plain JSON for Loki/CloudWatch (§13). Serializers are intentionally
 * minimal — we log method/url/status/latency/requestId and nothing else, so
 * headers (Authorization, device tokens) never reach the logs.
 */
export function buildLoggerOptions(config: ConfigService<Env, true>): Params {
  const isDev = config.get('NODE_ENV', { infer: true }) === 'development';

  return {
    pinoHttp: {
      genReqId: generateRequestId,
      level: isDev ? 'debug' : 'info',
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:standard' },
          }
        : undefined,
      autoLogging: {
        // Health probes fire constantly — logging them buries real traffic.
        ignore: (req) => SILENT_PATHS.has((req.url ?? '').split('?')[0]),
      },
      customLogLevel: (_req, res, err) => {
        // 503 is the one 5xx this API raises on purpose: a dependency is down,
        // which `AllExceptionsFilter` also logs at `warn` and for the same
        // reason. Deciding it here as well is what keeps an outage out of
        // `error` entirely — the request line is the other half of the pair,
        // and alerting keys on severity.
        //
        // Status-based rather than code-based because that is all pino-http
        // has, and nothing but `DependencyUnavailableError` produces a 503
        // (§9.2). It still attaches a synthesised `err` of its own to every
        // 5xx regardless of level (pino-http `logger.js`, `res.statusCode >=
        // 500`), so the line keeps a stack — one that names pino's own
        // `onResFinished` rather than anything that happened. Silencing that
        // is a change to how *all* errors are serialised, and is not this.
        if (res.statusCode === 503) return 'warn';
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({
          statusCode: res.statusCode,
        }),
      },
    },
  };
}
