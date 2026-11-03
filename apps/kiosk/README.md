# Kiosk app

The customer's ordering tablet.
A tablet is paired once with a code from a manager, and after that it orders and pays without any staff account.

## Screens

- Pairing, until the tablet holds a device token.
  The token is kept in `localStorage` and cleared when the API answers 401 to it: the device was revoked, or the server no longer knows the token (for example after a switch to another database).
- Menu, item options and the cart, which is checked against the menu on every refresh (the menu is polled about every 10 seconds).
- Payment, by card or by PromptPay, with a countdown taken from the server's clock.
- Confirmation, which follows the order until it is ready.
- Paused and revoked screens, and a banner when the API cannot be reached.

The tablet returns to the menu after a minute without a touch, except while a payment is under way.
A tablet that reloads mid-payment finds its unpaid order again and carries on with the same payment.

## Configuration

Settings are `VITE_` variables, read when the app starts.
A missing or malformed value shows a "not configured" screen rather than a half-working kiosk.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | The API origin. It must be in the API's `CORS_ORIGINS`. |
| `VITE_PAYMENTS` | `stripe` | `stripe`, or `fake` for development and the browser journeys. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | none | Required for `stripe`. The whole `pk_test_` or `pk_live_` key from the Stripe Dashboard, never a secret key. A placeholder such as `pk_test_...` shows the "not configured" screen. |
| `VITE_PROMPTPAY_EMAIL` | none | Required for `stripe`. See below. |
| `VITE_CURRENCY` | `THB` | Used to format prices. The API decides the real currency. |
| `VITE_TRACKER_POLL_MS` | `3000` | How often an open order is read as a backstop to the pushed events. |
| `VITE_IDLE_MS` | `60000` | Idle time before the tablet returns to the menu. |

`fake` mode draws a stand-in card field and a stand-in QR code, and shows a "TEST PAYMENTS" ribbon.
Nothing in it moves money, and a payment only completes when a signed webhook reaches the API.

## Payments

The API opens one PaymentIntent that allows both rails, and the kiosk picks how to confirm it.

Card uses Stripe's Card Element and `confirmCardPayment`.
A card that goes through is still not a payment: the screen waits for `payment.succeeded` or for the order to be read as paid.

PromptPay uses `confirmPromptPayPayment` with `handleActions: false`, and draws the QR code itself from the intent.
The Payment Element would open its own full-page QR lightbox, and a page cannot close that lightbox, so the code would stay on screen after the customer had paid.
Drawing it here lets `payment.succeeded` remove it at once.

Stripe requires an email for PromptPay, and a walk-up customer has none.
`VITE_PROMPTPAY_EMAIL` is sent as the billing email on every PromptPay payment, so use an address the cafe owns.
The API sets no `receipt_email`, so Stripe sends no receipt to it.

PromptPay must also be activated on the Stripe account before live mode.
In test mode it shows without that.

## Development

```bash
VITE_PAYMENTS=fake pnpm --filter @cafepos/kiosk dev
pnpm --filter @cafepos/kiosk test
```

The logic that decides what the screens show lives in `packages/api-client`, where it is tested: the payment flow, the order tracker, the menu and device-status feed, the cart and the order submitter.
This package keeps the pieces that need a browser or a build setting, and tests the rest of them in `test/`.
