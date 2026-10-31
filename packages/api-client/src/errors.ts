import type { ApiErrorCode, ProblemDetails } from './types';

/** The API answered with a non-2xx status and an RFC 9457 body. Switch on `code`, never on `detail`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;
  readonly problem: ProblemDetails | null;
  readonly requestId: string | null;

  constructor(
    status: number,
    problem: ProblemDetails | null,
    fallback: string,
  ) {
    super(problem?.detail ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
    this.requestId = problem?.requestId ?? null;
  }

  is(code: ApiErrorCode): boolean {
    return this.code === code;
  }
}

/** The request never produced a response: offline, DNS, refused, aborted. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the server.', { cause });
    this.name = 'NetworkError';
  }
}

export const isProblem = (value: unknown): value is ProblemDetails =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ProblemDetails).code === 'string' &&
  typeof (value as ProblemDetails).status === 'number';
