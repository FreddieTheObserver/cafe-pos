import type { PaymentGateway } from '@cafepos/api-client';

export interface CardField {
  mount(element: HTMLElement): () => void;
}

export interface KioskPayments {
  gateway: PaymentGateway;
  cardField: CardField;
  testMode: boolean;
}
