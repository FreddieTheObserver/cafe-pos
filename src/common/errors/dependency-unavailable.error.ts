import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * A dependency this request needed is not reachable (§9.2, 503).
 *
 * Distinct from a 500 on purpose. A 500 says "we have a bug"; this says "the
 * request was refused, deliberately, and retrying later will work" — which is
 * the difference between paging an engineer and a kiosk showing its offline
 * screen and trying again. §9.2's table names Redis being down as one of the
 * things this code is for.
 *
 * The caller supplies `detail` because the useful sentence is always about
 * what could not be done for *this* request, never which host stopped
 * answering — a client cannot act on our topology, and §9.1 says not to
 * describe it.
 */
export class DependencyUnavailableError extends AppException {
  constructor(detail: string) {
    super({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      status: 503,
      title: 'Service unavailable',
      detail,
    });
  }
}
