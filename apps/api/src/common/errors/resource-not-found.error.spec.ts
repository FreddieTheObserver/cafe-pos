import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';
import { ResourceNotFoundError } from './resource-not-found.error';

describe('ResourceNotFoundError', () => {
  it('carries the §9.2 code and status', () => {
    const error = new ResourceNotFoundError('user');

    expect(error).toBeInstanceOf(AppException);
    expect(error.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(error.status).toBe(404);
  });

  it('names the kind of thing that was missing', () => {
    expect(new ResourceNotFoundError('device').detail).toMatch(/device/i);
  });

  /**
   * §5.2 uses 404 for out-of-scope resources too ("no existence leak"), so the
   * message must not reveal whether the row exists and was merely off-limits.
   */
  it('says nothing about why it was not found', () => {
    const error = new ResourceNotFoundError('order', 'some-id');

    expect(error.detail).not.toMatch(/permission|forbidden|scope|belongs/i);
    expect(error.detail).not.toContain('some-id');
  });
});
