/** One field-level validation failure (populated only for 422 responses, §9.1). */
export interface ValidationErrorItem {
  field: string;
  rule: string;
  message: string;
}

/**
 * The single error shape every non-2xx response uses (RFC 9457, extended, §9.1).
 * Clients switch on `code` — never on `detail` text.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId: string;
  errors: ValidationErrorItem[] | null;
  meta: Record<string, unknown> | null;
}

const ERROR_TYPE_BASE = 'https://cafepos.dev/errors/';

/** Derives the `type` URI from a code, e.g. ORDER_INVALID_TRANSITION → .../order-invalid-transition. */
export const errorType = (code: string): string =>
  ERROR_TYPE_BASE + code.toLowerCase().replace(/_/g, '-');
