import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * A resource that does not exist — or that the caller may not see (§5.2).
 *
 * The two cases are deliberately indistinguishable. A kiosk asking for another
 * device's order gets this, not a 403: "you are not allowed to see this" still
 * confirms the row exists, which is the existence leak §5.2 rules out. The
 * detail names only the *kind* of thing, never the id or the reason.
 */
export class ResourceNotFoundError extends AppException {
  constructor(resource: string, id?: string) {
    super({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      status: 404,
      title: 'Not found',
      detail: `No such ${resource}.`,
      // Echoing the id back is safe — the caller just sent it in the URL — and
      // it gives clients something to correlate. What is never disclosed is
      // *why*: missing and forbidden produce identical envelopes.
      meta: id === undefined ? null : { resource, id },
    });
  }
}
