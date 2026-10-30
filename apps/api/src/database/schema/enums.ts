/**
 * String-literal enum tuples. Each is used twice: as Drizzle's `text({ enum })`
 * (compile-time narrowing) and as a DB CHECK constraint (§7.4 last line of
 * defense). Kept here so the two can never disagree.
 */

export const userRoles = ['ADMIN', 'MANAGER', 'CASHIER', 'BARISTA'] as const;
export type UserRole = (typeof userRoles)[number];

export const deviceStatuses = [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'REVOKED',
] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];

export const orderChannels = ['KIOSK', 'COUNTER'] as const;
export type OrderChannel = (typeof orderChannels)[number];

export const orderStatuses = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PAID',
  'IN_PREPARATION',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const actorTypes = ['USER', 'DEVICE', 'SYSTEM'] as const;
export type ActorType = (typeof actorTypes)[number];

export const paymentProviders = ['STRIPE', 'CASH'] as const;
export type PaymentProvider = (typeof paymentProviders)[number];

export const paymentMethods = ['CARD', 'PROMPTPAY', 'CASH'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentStatuses = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const refundStatuses = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type RefundStatus = (typeof refundStatuses)[number];
