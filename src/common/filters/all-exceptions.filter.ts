import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import { ZodError } from 'zod';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import {
  errorType,
  type ProblemDetails,
  type ValidationErrorItem,
} from '../errors/problem-details';
import { getRequestId } from '../http/request-id';

/** Default code + title per HTTP status for framework-raised HttpExceptions. */
const HTTP_STATUS_MAP: Record<number, { code: string; title: string }> = {
  400: { code: ErrorCode.BAD_REQUEST, title: 'Bad request' },
  401: { code: ErrorCode.AUTH_TOKEN_INVALID, title: 'Unauthorized' },
  403: { code: ErrorCode.FORBIDDEN_ROLE, title: 'Forbidden' },
  404: { code: ErrorCode.RESOURCE_NOT_FOUND, title: 'Not found' },
  409: { code: ErrorCode.CONFLICT, title: 'Conflict' },
  413: { code: ErrorCode.PAYLOAD_TOO_LARGE, title: 'Payload too large' },
  422: { code: ErrorCode.VALIDATION_FAILED, title: 'Validation failed' },
  429: { code: ErrorCode.RATE_LIMITED, title: 'Too many requests' },
  503: { code: ErrorCode.DEPENDENCY_UNAVAILABLE, title: 'Service unavailable' },
};

/**
 * The single global filter (§9.3). Controllers never build error responses by
 * hand — everything thrown anywhere ends up here and leaves as one envelope.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const requestId = getRequestId(req);

    const problem = this.toProblem(exception, requestId);

    // 5xx means a human should look — log with the stack, but never leak it out.
    if (problem.status >= 500) {
      this.logger.error(
        `${problem.code} ${req.method} ${req.url} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.reply(ctx.getResponse(), problem, problem.status);
  }

  private toProblem(exception: unknown, requestId: string): ProblemDetails {
    if (exception instanceof AppException) {
      return build({
        code: exception.code,
        status: exception.status,
        title: exception.title,
        detail: exception.detail,
        requestId,
        errors: exception.errors,
        meta: exception.meta,
      });
    }

    if (exception instanceof ZodError) {
      const errors: ValidationErrorItem[] = exception.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        rule: issue.code,
        message: issue.message,
      }));
      return build({
        code: ErrorCode.VALIDATION_FAILED,
        status: 422,
        title: 'Validation failed',
        detail: 'One or more fields are invalid.',
        requestId,
        errors,
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // A 5xx carries no client-actionable information and may quote internals
      // (driver messages, connection strings) — say nothing, log everything.
      if (status >= 500) return internal(requestId);
      return clientProblem(status, extractHttpDetail(exception), requestId);
    }

    // multer is the same category as body-parser below, except its errors
    // carry a `code` and no status at all — so without this an oversized image
    // upload would be reported as a 500 and page someone over a manager
    // picking too big a photo.
    const multerStatus = multerStatusOf(exception);
    if (multerStatus !== undefined) {
      return clientProblem(
        multerStatus,
        (exception as Error).message,
        requestId,
      );
    }

    // Express middleware (body-parser especially) rejects requests with plain
    // Errors that carry an HTTP status rather than HttpExceptions. A body over
    // the size limit is the client's mistake, not ours — reporting it as 500
    // would page a human and hide the real cause from the caller.
    const status = httpStatusOf(exception);
    if (status !== undefined && status >= 400 && status < 500) {
      return clientProblem(status, (exception as Error).message, requestId);
    }

    // Anything else is a bug — generic 500, details go to the log only.
    return internal(requestId);
  }
}

/** Longest `detail` we echo back; keeps a hostile or verbose message bounded. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Recognised structurally rather than by importing multer, which is a
 * transitive dependency of the Express platform adapter and has no business
 * being a direct import of the generic error filter.
 */
function multerStatusOf(exception: unknown): number | undefined {
  const candidate = exception as { name?: unknown; code?: unknown };
  if (candidate?.name !== 'MulterError') return undefined;
  // Every other limit (part counts, field sizes, an unexpected field name) is
  // a malformed form rather than an oversized one.
  return candidate.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
}

/** Reads a numeric HTTP status off an Express-style error, if it has one. */
function httpStatusOf(exception: unknown): number | undefined {
  const candidate = exception as
    { status?: unknown; statusCode?: unknown } | undefined;
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function clientProblem(
  status: number,
  detail: string,
  requestId: string,
): ProblemDetails {
  const mapped = HTTP_STATUS_MAP[status] ?? {
    code: ErrorCode.BAD_REQUEST,
    title: 'Bad request',
  };
  return build({
    code: mapped.code,
    status,
    title: mapped.title,
    detail: truncate(detail),
    requestId,
  });
}

function internal(requestId: string): ProblemDetails {
  return build({
    code: ErrorCode.INTERNAL,
    status: 500,
    title: 'Internal server error',
    detail: 'An unexpected error occurred.',
    requestId,
  });
}

const truncate = (detail: string): string =>
  detail.length > MAX_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : detail;

function build(p: {
  code: string;
  status: number;
  title: string;
  detail: string;
  requestId: string;
  errors?: ValidationErrorItem[] | null;
  meta?: Record<string, unknown> | null;
}): ProblemDetails {
  return {
    type: errorType(p.code),
    title: p.title,
    status: p.status,
    code: p.code,
    detail: p.detail,
    requestId: p.requestId,
    errors: p.errors ?? null,
    meta: p.meta ?? null,
  };
}

/** Pulls a human string out of a Nest HttpException's varied response shapes. */
function extractHttpDetail(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string') return message;
  return exception.message;
}
