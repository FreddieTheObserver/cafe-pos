import type { KioskPayments } from './types';

const QR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#fff"/><rect x="20" y="20" width="200" height="200" fill="#000"/><text x="120" y="130" font-size="28" text-anchor="middle" fill="#fff">TEST QR</text></svg>',
)}`;

export const createFakePayments = (): KioskPayments => ({
  testMode: true,
  cardField: {
    mount(element) {
      const box = document.createElement('div');
      box.dataset.testid = 'fake-card';
      box.textContent = 'Test card (no real payment)';
      element.append(box);
      return () => box.remove();
    },
  },
  gateway: {
    payByCard: async () => ({ ok: true }),
    startPromptPay: async () => ({ ok: true, qrImageUrl: QR }),
  },
});
