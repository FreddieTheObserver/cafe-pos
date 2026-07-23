import type { ValidationErrorItem } from './problem-details';

/**
 * Base class for all domain exceptions. Each carries the machine `code`, HTTP
 * `status`, human `title`, and optional `meta` the global filter needs to build
 * the Problem Details envelope (§9.3). Domain phases subclass this with fixed
 * values, e.g. `class OrderInvalidTransitionError extends AppException`.
 */
export class AppException extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly meta: Record<string, unknown> | null;
  readonly errors: ValidationErrorItem[] | null;

  constructor(params: {
    code: string;
    status: number;
    title: string;
    detail: string;
    meta?: Record<string, unknown> | null;
    errors?: ValidationErrorItem[] | null;
  }) {
    super(params.detail);
    this.name = new.target.name;
    this.code = params.code;
    this.status = params.status;
    this.title = params.title;
    this.meta = params.meta ?? null;
    this.errors = params.errors ?? null;
  }

  /** The human-readable explanation — never contains secrets or stack detail (§9.1). */
  get detail(): string {
    return this.message;
  }
}
