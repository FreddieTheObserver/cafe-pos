import {
  ApiError,
  addLine,
  createOrderSubmitter,
  dropUnsellable,
  type CartLine,
  type MenuEntry,
  type PlaceOrderResult,
} from '@cafepos/api-client';
import { useEffect, useMemo, useState } from 'react';
import type { KioskConfig } from './config';
import { useIdle, type Connection } from './hooks';
import { t } from './i18n';
import type { KioskPayments } from './payments';
import { isResumable } from './resume';
import { Blocked } from './screens/Blocked';
import { CartScreen } from './screens/Cart';
import { ItemSheet } from './screens/ItemSheet';
import { MenuScreen } from './screens/Menu';
import { Order, type PlacedOrder } from './screens/Order';
import type { Stores } from './stores';

type Screen =
  { kind: 'menu' } | { kind: 'cart' } | { kind: 'order'; order: PlacedOrder };

interface Props {
  config: KioskConfig;
  conn: Connection;
  stores: Stores;
  payments: KioskPayments;
}

const failureText = (result: PlaceOrderResult): string | null => {
  switch (result.kind) {
    case 'price-changed':
      return t('cart.result.priceChanged');
    case 'unavailable':
      return t('cart.result.unavailable');
    case 'invalid-selection':
      return t('cart.result.invalidSelection');
    case 'offline':
      return t('cart.result.offline');
    case 'rate-limited':
      return t('cart.result.rateLimited');
    case 'error':
      return t('cart.result.error');
    default:
      return null;
  }
};

export function Kiosk({ config, conn, stores, payments }: Props) {
  const { api, feed } = conn;
  const submitter = useMemo(() => createOrderSubmitter(api), [api]);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [picked, setPicked] = useState<MenuEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [resuming, setResuming] = useState(
    () => stores.activeOrder.get() !== null,
  );

  useEffect(() => {
    const id = stores.activeOrder.get();
    if (!id) return;
    let cancelled = false;
    api.orders
      .get(id)
      .then((order) => {
        if (cancelled) return;
        if (isResumable(order.status)) setScreen({ kind: 'order', order });
        else stores.activeOrder.clear();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404)
          stores.activeOrder.clear();
      })
      .finally(() => !cancelled && setResuming(false));
    return () => {
      cancelled = true;
    };
  }, [api, stores]);

  const reset = () => {
    stores.activeOrder.clear();
    setLines([]);
    setPicked(null);
    setNotice(null);
    setScreen({ kind: 'menu' });
  };

  useIdle(screen.kind !== 'order', config.idleMs, reset);

  const pay = async () => {
    if (!feed.menu) return;
    setPlacing(true);
    setNotice(null);
    const result = await submitter.submit(feed.menu, lines);
    setPlacing(false);
    if (result.kind === 'placed') {
      stores.activeOrder.set(result.order.id);
      setScreen({ kind: 'order', order: result.order });
      return;
    }
    if (result.kind === 'paused' || result.kind === 'revoked')
      await conn.pollStatus();
    else if (
      ['price-changed', 'unavailable', 'invalid-selection'].includes(
        result.kind,
      )
    )
      await conn.pollMenu();
    setNotice(failureText(result));
  };

  const exit = () => {
    if (screen.kind === 'order') stores.paymentKeys.clear(screen.order.id);
    reset();
  };

  if (resuming) return <p className="center muted">{t('menu.resume')}</p>;

  if (screen.kind === 'order')
    return (
      <Order
        key={screen.order.id}
        order={screen.order}
        conn={conn}
        payments={payments}
        config={config}
        stores={stores}
        onExit={exit}
      />
    );

  if (feed.status === 'PAUSED' || feed.status === 'PENDING')
    return <Blocked status={feed.status} />;

  if (screen.kind === 'cart' && feed.menu)
    return (
      <CartScreen
        menu={feed.menu}
        lines={lines}
        currency={config.currency}
        notice={notice}
        placing={placing}
        onChange={(next) => {
          setNotice(null);
          setLines(next);
          if (next.length === 0) setScreen({ kind: 'menu' });
        }}
        onDropUnsellable={() =>
          feed.menu && setLines(dropUnsellable(feed.menu, lines))
        }
        onBack={() => setScreen({ kind: 'menu' })}
        onPay={() => void pay()}
      />
    );

  return (
    <>
      <MenuScreen
        menu={feed.menu}
        online={feed.online}
        currency={config.currency}
        lines={lines}
        onPick={setPicked}
        onViewCart={() => setScreen({ kind: 'cart' })}
      />
      {picked && (
        <ItemSheet
          entry={picked}
          currency={config.currency}
          onClose={() => setPicked(null)}
          onAdd={(line) => {
            setLines((current) =>
              addLine(current, line, () => crypto.randomUUID()),
            );
            setPicked(null);
          }}
        />
      )}
    </>
  );
}
