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
      const mapped = HTTP_STATUS_MAP[status] ?? {
        code: ErrorCode.INTERNAL,
        title: 'Error',
      };
      return build({
        code: mapped.code,
        status,
        title: mapped.title,
        detail: extractHttpDetail(exception),
        requestId,
      });
    }

    // Anything else is a bug — generic 500, details go to the log only.
    return build({
      code: ErrorCode.INTERNAL,
      status: 500,
      title: 'Internal server error',
      detail: 'An unexpected error occurred.',
      requestId,
    });
  }
}

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
