/**
 * Cross-cutting error codes the global filter needs to map framework-level
 * failures (validation, not-found, rate limits, unhandled). Domain-specific
 * codes from §9.2 (ORDER_INVALID_TRANSITION, PRICE_MISMATCH, ...) are defined
 * alongside the typed exceptions that raise them, in their own phases.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
