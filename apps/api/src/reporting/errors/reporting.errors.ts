import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Deliberately a plain `Error` rather than an `AppException`.
 *
 * Everything in the §9.2 catalog describes something a *client* did — a bad
 * transition, an over-refund, a duplicated idempotency key — and carries a code
 * so the caller can act on it. This is the opposite: it marks a bug in our own
 * code, and there is nothing a kiosk or a manager could do differently. Giving
 * it an error code would put a rung in the public catalog that no request can
 * ever legitimately produce.
 *
 * It surfaces as a 500 through the exception filter, which is the correct
 * outcome for a tripwire: loud, logged with a request id, and impossible to
 * mistake for normal operation.
 */
export class BusinessDayNotClosedError extends Error {
  constructor(
    readonly businessDay: string,
    readonly currentBusinessDay: string,
  ) {
    super(
      `Refusing to roll up ${businessDay}: the current business day is ${currentBusinessDay}, so ${businessDay} is either still trading or has not started. A rollup row is treated as final by the catch-up sweep, and finalizing a partial day would freeze it permanently.`,
    );
    this.name = 'BusinessDayNotClosedError';
  }
}

/**
 * A range the caller may not ask for (§5.4's 422).
 *
 * Unlike `BusinessDayNotClosedError`, this one *is* a client error with a code
 * the caller can act on — they asked for something outside the allowed window
 * and can narrow it and retry.
 */
export class UnprocessableRangeError extends AppException {
  constructor(detail: string) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      status: 422,
      title: 'Unprocessable range',
      detail,
    });
  }
}
