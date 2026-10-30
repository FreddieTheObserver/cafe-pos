import { hashRequest } from './request-hash';

const SCOPE = 'device:0190a1b2';

describe('hashRequest', () => {
  it('is stable across runs for the same input', () => {
    const body = {
      channel: 'KIOSK',
      items: [{ menuItemId: 'a', quantity: 1 }],
    };

    expect(hashRequest(SCOPE, body)).toBe(hashRequest(SCOPE, body));
  });

  /**
   * The point of canonicalising rather than hashing the raw bytes. Two clients
   * serialising the same basket with their keys in a different order have sent
   * the same request, and answering the second with `IDEMPOTENCY_CONFLICT`
   * would be a retry refused for no reason.
   */
  it('ignores the order keys were serialised in', () => {
    const a = { channel: 'KIOSK', customerName: 'Mei', items: [] };
    const b = { items: [], customerName: 'Mei', channel: 'KIOSK' };

    expect(hashRequest(SCOPE, a)).toBe(hashRequest(SCOPE, b));
  });

  it('ignores key order at every depth', () => {
    const a = { items: [{ menuItemId: 'a', quantity: 2, notes: null }] };
    const b = { items: [{ notes: null, quantity: 2, menuItemId: 'a' }] };

    expect(hashRequest(SCOPE, a)).toBe(hashRequest(SCOPE, b));
  });

  /** A basket is not a set: two lines swapped is a different receipt to read. */
  it('treats array order as significant', () => {
    const a = { items: [{ menuItemId: 'a' }, { menuItemId: 'b' }] };
    const b = { items: [{ menuItemId: 'b' }, { menuItemId: 'a' }] };

    expect(hashRequest(SCOPE, a)).not.toBe(hashRequest(SCOPE, b));
  });

  it('separates a changed value from an unchanged one', () => {
    const one = { items: [{ menuItemId: 'a', quantity: 1 }] };
    const two = { items: [{ menuItemId: 'a', quantity: 2 }] };

    expect(hashRequest(SCOPE, one)).not.toBe(hashRequest(SCOPE, two));
  });

  it('distinguishes an explicit null from an absent field', () => {
    expect(hashRequest(SCOPE, { customerName: null })).not.toBe(
      hashRequest(SCOPE, {}),
    );
  });

  /**
   * Keys are client-generated UUIDs, so a collision between two tablets is not
   * a real worry — but scoping by principal means a guessed key cannot be used
   * to pull back somebody else's order, and costs one string to add.
   */
  it('separates identical bodies sent by different principals', () => {
    const body = { channel: 'KIOSK', items: [] };

    expect(hashRequest('device:one', body)).not.toBe(
      hashRequest('device:two', body),
    );
  });

  // The scope and the body are joined before hashing, so a scope that ends
  // where a body begins must not be able to impersonate a different pair.
  it('cannot be confused by a scope that looks like part of the body', () => {
    expect(hashRequest('device:a', { b: 1 })).not.toBe(
      hashRequest('device', { a: { b: 1 } }),
    );
  });

  it('returns a hex digest', () => {
    expect(hashRequest(SCOPE, {})).toMatch(/^[0-9a-f]{64}$/);
  });
});
