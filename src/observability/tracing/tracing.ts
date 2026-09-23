import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  serviceName: string;
  sampleRatio: number;
}

// Section 13: 10% of traces. Keeping every erroring request is a tail-sampling
// decision, which only the collector can make once a trace has finished.
const DEFAULT_SAMPLE_RATIO = 0.1;

// Probes and scrapes fire every few seconds and would drown the traces that matter.
const UNTRACED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Tracing is on only when there is somewhere to send it. Reads the standard
 * OpenTelemetry variables, so a platform's collector configuration applies as is.
 */
export function tracingOptionsFrom(
  env: NodeJS.ProcessEnv,
): TracingOptions | null {
  const endpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  const raw = env.OTEL_TRACES_SAMPLER_ARG;
  const sampleRatio =
    raw === undefined || raw === '' ? DEFAULT_SAMPLE_RATIO : Number(raw);
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) {
    throw new Error(
      `OTEL_TRACES_SAMPLER_ARG must be a ratio between 0 and 1, not "${raw}".`,
    );
  }

  return { serviceName: env.OTEL_SERVICE_NAME || 'cafe-pos', sampleRatio };
}

/**
 * Starts the OpenTelemetry SDK, or does nothing when tracing is off.
 *
 * Must run before the modules it instruments are first required, which is why
 * `instrument.ts` calls it and `main.ts` imports that first.
 */
export function startTracing(env: NodeJS.ProcessEnv): NodeSDK | null {
  const options = tracingOptionsFrom(env);
  if (options === null) return null;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio),
    }),
    traceExporter: new OTLPTraceExporter(),
    // Traces only. Left to its own devices, NodeSDK reads the same
    // OTEL_EXPORTER_OTLP_ENDPOINT and quietly starts OTLP logs and metrics
    // pipelines beside this one, in protobuf. Metrics are already served to
    // Prometheus on their own port (§13), and logs go to stdout as pino JSON,
    // so those exports would be a duplicate nobody reads.
    logRecordProcessors: [],
    metricReaders: [],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) =>
          UNTRACED_PATHS.has((req.url ?? '').split('?')[0]),
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
