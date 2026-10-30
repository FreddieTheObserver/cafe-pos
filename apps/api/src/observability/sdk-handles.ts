import type { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * What `instrument.ts` started, for the shutdown hook to flush. Set once, before
 * Nest exists; empty in the test harness, which never loads `instrument.ts`.
 */
export const sdkHandles: { tracing: NodeSDK | null; errorReporting: boolean } =
  { tracing: null, errorReporting: false };
