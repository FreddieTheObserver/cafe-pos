import { describe, expect, it } from 'vitest';
import { isResumable } from '../src/resume';

describe('isResumable', () => {
  it.each(['PENDING_PAYMENT', 'PAID', 'IN_PREPARATION', 'READY'] as const)(
    'resumes an order that is %s',
    (status) => {
      expect(isResumable(status)).toBe(true);
    },
  );

  it.each(['DRAFT', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const)(
    'drops an order that is %s',
    (status) => {
      expect(isResumable(status)).toBe(false);
    },
  );
});
