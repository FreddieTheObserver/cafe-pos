import type { KioskConfig } from '../config';
import { createFakePayments } from './fake';
import { createStripePayments } from './stripe';
import type { KioskPayments } from './types';

export type { CardField, KioskPayments } from './types';

export const createPayments = (config: KioskConfig): KioskPayments =>
  config.payments.mode === 'fake'
    ? createFakePayments()
    : createStripePayments(config.payments);
