// Imported first by main.ts. OpenTelemetry patches modules as they are first
// required, so anything loaded before this would go untraced. dotenv first, so
// these SDKs read the same environment ConfigModule will.
import 'dotenv/config';
import { startErrorReporting } from './observability/errors/error-reporting';
import { sdkHandles } from './observability/sdk-handles';
import { startTracing } from './observability/tracing/tracing';

sdkHandles.tracing = startTracing(process.env);
sdkHandles.errorReporting = startErrorReporting(process.env);
