// The DESIGN.md section 14 load test: 4 kiosks and 2 counter tills at three
// times the assumed peak (18 orders a minute), a 50 requests-a-second menu
// burst, and 20 kitchen screens holding sockets, for 30 minutes. A regression
// gate, not a capacity hunt: p95 under 300 ms and no 5xx, then verify.sql for
// the state machine and the money rules.
//
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 \
//     grafana/k6:2.3.0 run - < ops/load/cafepos.k6.js
//
// The API under test must point at stripe-mock or Stripe test mode, never live.
// Pairing is limited to 5 devices an hour per address; reuse kiosks across
// runs by passing their tokens as KIOSK_TOKENS=token1,token2,...
import http from 'k6/http';
import ws from 'k6/ws';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const DURATION = __ENV.DURATION || '30m';
const PASSWORD = __ENV.SEED_PASSWORD || 'cafepos-dev-password';
const KIOSKS = 4;

const serverErrors = new Counter('server_errors');
const kdsEvents = new Counter('kds_events');

function seconds(duration) {
  const match = /^(\d+)(s|m|h)$/.exec(duration);
  if (!match) fail(`DURATION must look like 90s, 30m or 1h, not ${duration}`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
}

const RUN_SECONDS = seconds(DURATION);

export const options = {
  scenarios: {
    kiosk_orders: {
      executor: 'constant-arrival-rate',
      exec: 'kioskOrder',
      rate: 12,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: KIOSKS,
      maxVUs: KIOSKS,
    },
    counter_orders: {
      executor: 'constant-arrival-rate',
      exec: 'counterOrder',
      rate: 6,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 2,
    },
    // Halfway through, while the order traffic is running.
    menu_burst: {
      executor: 'constant-arrival-rate',
      exec: 'readMenu',
      rate: 50,
      timeUnit: '1s',
      // 30 s: the 600-a-minute backstop is per kiosk, and 50 a second over four
      // kiosks for a full minute would be refused by it, testing the test.
      duration: `${Math.min(30, Math.max(10, Math.floor(RUN_SECONDS / 3)))}s`,
      startTime: `${Math.floor(RUN_SECONDS / 2)}s`,
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
    kds_screens: {
      executor: 'constant-vus',
      exec: 'kdsScreen',
      vus: 20,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    server_errors: ['count==0'],
    checks: ['rate==1'],
  },
};

const json = (token) => ({
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});

const withKey = (token) => {
  const params = json(token);
  params.headers['Idempotency-Key'] = `load-${__VU}-${__ITER}-${Date.now()}`;
  return params;
};

/** Checks the status, and counts any 5xx against the zero the gate allows. */
function expectStatus(res, status, what) {
  if (res.status >= 500) serverErrors.add(1, { what });
  const ok = check(res, { [`${what} is ${status}`]: (r) => r.status === status });
  return ok;
}

function login(email) {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    json(),
  );
  if (res.status !== 200) fail(`login ${email}: ${res.status} ${res.body}`);
  return { access: res.json('accessToken'), refresh: res.json('refreshToken') };
}

// Access tokens live 15 minutes and the run is 30. Each VU holds its own
// session and refreshes it: refresh tokens rotate, and two VUs sharing one would
// trip reuse detection and revoke both.
const REFRESH_AFTER_MS = 10 * 60 * 1000;
const sessions = {};

function staffToken(email) {
  const now = Date.now();
  const session = sessions[email];
  if (session === undefined) {
    sessions[email] = { ...login(email), at: now };
  } else if (now - session.at > REFRESH_AFTER_MS) {
    const res = http.post(
      `${API}/auth/refresh`,
      JSON.stringify({ refreshToken: session.refresh }),
      json(),
    );
    if (res.status !== 200) fail(`refresh ${email}: ${res.status}`);
    sessions[email] = {
      access: res.json('accessToken'),
      refresh: res.json('refreshToken'),
      at: now,
    };
  }
  return sessions[email].access;
}

function pairKiosks(managerToken) {
  const tokens = [];
  for (let i = 0; i < KIOSKS; i += 1) {
    const created = http.post(
      `${API}/devices`,
      JSON.stringify({ name: `Load kiosk ${i + 1} ${Date.now()}` }),
      json(managerToken),
    );
    if (created.status !== 201) fail(`create device: ${created.status}`);
    const activated = http.post(
      `${API}/devices/activate`,
      JSON.stringify({ pairingCode: created.json('pairingCode') }),
      json(),
    );
    if (activated.status !== 200) {
      fail(
        `activate device: ${activated.status}. Pairing allows 5 an hour; pass KIOSK_TOKENS to reuse kiosks.`,
      );
    }
    tokens.push(activated.json('deviceToken'));
  }
  return tokens;
}

/** An available item every basket can use: one with no required options. */
function pickItem(kioskToken) {
  const res = http.get(`${API}/menu`, json(kioskToken));
  if (res.status !== 200) fail(`menu: ${res.status}`);
  for (const category of res.json('categories')) {
    for (const item of category.items) {
      const needsChoice = item.optionGroups.some((group) => group.minSelect > 0);
      if (item.isAvailable && !needsChoice) return item.id;
    }
  }
  fail('the menu has no available item without required options: run pnpm db:seed');
}

export function setup() {
  const kioskTokens = __ENV.KIOSK_TOKENS
    ? __ENV.KIOSK_TOKENS.split(',')
    : pairKiosks(login('manager@cafepos.local').access);
  return {
    // Only for the kitchen screens' handshakes, all made at the start of the run.
    kitchen: login('barista@cafepos.local').access,
    kioskTokens,
    itemId: pickItem(kioskTokens[0]),
  };
}

const basket = (itemId, channel) =>
  JSON.stringify({
    channel,
    items: [{ menuItemId: itemId, quantity: 1, optionIds: [] }],
  });

/** A customer at a kiosk: reads the menu, orders, opens a card payment, walks away. */
export function kioskOrder(data) {
  const token = data.kioskTokens[(__VU - 1) % data.kioskTokens.length];

  expectStatus(http.get(`${API}/menu`, json(token)), 200, 'kiosk menu');

  const order = http.post(`${API}/orders`, basket(data.itemId, 'KIOSK'), withKey(token));
  if (!expectStatus(order, 201, 'kiosk order')) return;
  const orderId = order.json('id');

  const payment = http.post(
    `${API}/orders/${orderId}/payments`,
    JSON.stringify({ method: 'CARD' }),
    withKey(token),
  );
  expectStatus(payment, 201, 'kiosk payment');

  // Abandoned at the Payment Element: cancelling also cancels the intent.
  const cancelled = http.post(
    `${API}/orders/${orderId}/cancel`,
    JSON.stringify({ reason: 'Load test: customer walked away' }),
    json(token),
  );
  expectStatus(cancelled, 200, 'kiosk cancel');
}

/** A counter sale in cash, then the bar takes it through to collection. */
export function counterOrder(data) {
  const cashier = staffToken('cashier@cafepos.local');
  const barista = staffToken('barista@cafepos.local');

  const order = http.post(
    `${API}/orders`,
    basket(data.itemId, 'COUNTER'),
    withKey(cashier),
  );
  if (!expectStatus(order, 201, 'counter order')) return;
  const orderId = order.json('id');

  const paid = http.post(
    `${API}/orders/${orderId}/payments`,
    JSON.stringify({ method: 'CASH', cashTenderedMinor: order.json('totalMinor') }),
    withKey(cashier),
  );
  if (!expectStatus(paid, 201, 'cash payment')) return;

  for (const to of ['IN_PREPARATION', 'READY', 'COMPLETED']) {
    const moved = http.post(
      `${API}/orders/${orderId}/status`,
      JSON.stringify({ to }),
      json(barista),
    );
    if (!expectStatus(moved, 200, `move to ${to}`)) return;
  }
}

export function readMenu(data) {
  const token = data.kioskTokens[__ITER % data.kioskTokens.length];
  expectStatus(http.get(`${API}/menu`, json(token)), 200, 'menu burst');
}

/**
 * A kitchen screen: Socket.IO over a raw WebSocket. Engine.IO opens with a
 * `0` packet, the namespace connect carries the token, and the server's pings
 * (`2`) must be answered (`3`) or it hangs up.
 */
export function kdsScreen(data) {
  const url = `${BASE.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  const res = ws.connect(url, {}, (socket) => {
    socket.on('message', (message) => {
      if (message.startsWith('0')) {
        socket.send(`40/kds,${JSON.stringify({ token: data.kitchen })}`);
      } else if (message === '2') {
        socket.send('3');
      } else if (message.startsWith('40/kds')) {
        check(message, { 'kitchen screen connected': () => true });
      } else if (message.startsWith('44/kds')) {
        check(message, { 'kitchen screen connected': () => false });
        socket.close();
      } else if (message.startsWith('42/kds')) {
        kdsEvents.add(1);
      }
    });
    socket.setTimeout(() => socket.close(), RUN_SECONDS * 1000);
  });
  check(res, { 'kitchen socket upgraded': (r) => r && r.status === 101 });
}
