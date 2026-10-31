import type { OrderStatus } from '@cafepos/api-client';

export const isResumable = (status: OrderStatus): boolean =>
  ['PENDING_PAYMENT', 'PAID', 'IN_PREPARATION', 'READY'].includes(status);
