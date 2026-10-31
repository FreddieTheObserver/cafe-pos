import {
  createOrderTracker,
  createPaymentFlow,
  type OrderPhase,
  type OrderView,
  type PaymentFlowState,
} from '@cafepos/api-client';
import { useEffect, useRef, useState } from 'react';
import type { KioskConfig } from '../config';
import { formatCountdown, formatMoney } from '../format';
import { useIdle, useSecondsLeft, type Connection } from '../hooks';
import { t } from '../i18n';
import type { KioskPayments } from '../payments';
import type { Stores } from '../stores';

export type PlacedOrder = Pick<
  OrderView,
  'id' | 'orderNumber' | 'totalMinor' | 'currency' | 'expiresAt'
>;

interface Props {
  order: PlacedOrder;
  conn: Connection;
  payments: KioskPayments;
  config: KioskConfig;
  stores: Stores;
  onExit: () => void;
}

type Flow = ReturnType<typeof createPaymentFlow>;

const STATUS_TEXT: Partial<Record<OrderPhase, Parameters<typeof t>[0]>> = {
  paid: 'status.paid',
  preparing: 'status.preparing',
  ready: 'status.ready',
  collected: 'status.collected',
};

function CardField({
  payments,
  disabled,
}: {
  payments: KioskPayments;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => payments.cardField.mount(host.current!), [payments]);
  return (
    <div
      ref={host}
      className="card-field"
      aria-label={t('pay.cardDetails')}
      aria-disabled={disabled}
    />
  );
}

export function Order({
  order,
  conn,
  payments,
  config,
  stores,
  onExit,
}: Props) {
  const [flow, setFlow] = useState<PaymentFlowState>({ phase: 'opening' });
  const [phase, setPhase] = useState<OrderPhase>('awaiting-payment');
  const [online, setOnline] = useState(true);
  const [cancelFailed, setCancelFailed] = useState(false);
  const controls = useRef<Flow | null>(null);
  const { api, events, clock } = conn;
  const secondsLeft = useSecondsLeft(clock, order.expiresAt);
  const total = formatMoney(order.totalMinor, order.currency);

  useEffect(() => {
    const paymentFlow = createPaymentFlow({
      api,
      events,
      gateway: payments.gateway,
      keys: stores.paymentKeys,
      orderId: order.id,
      onChange: setFlow,
    });
    const tracker = createOrderTracker({
      api,
      events,
      orderId: order.id,
      pollMs: config.trackerPollMs,
      onChange: (next, isOnline) => {
        setPhase(next);
        setOnline(isOnline);
        paymentFlow.orderPhaseChanged(next);
      },
    });
    controls.current = paymentFlow;
    void paymentFlow.start();
    tracker.start();
    return () => {
      paymentFlow.stop();
      tracker.stop();
      controls.current = null;
    };
  }, [api, events, payments, config.trackerPollMs, stores, order.id]);

  const paid = flow.phase === 'paid';
  useIdle(paid, config.idleMs, onExit);

  const cancel = async () => {
    setCancelFailed(false);
    try {
      await api.orders.cancel(order.id);
      stores.paymentKeys.clear(order.id);
      onExit();
    } catch {
      setCancelFailed(true);
    }
  };

  if (paid) {
    const text = STATUS_TEXT[phase] ?? 'status.paid';
    return (
      <main className="panel narrow center">
        <p className="muted">{t('order.number')}</p>
        <p className="number" data-testid="order-number">
          {order.orderNumber}
        </p>
        <p role="status" className="status">
          {t(text)}
        </p>
        <p className="muted">{t('status.watch')}</p>
        {!online && <p className="banner">{t('order.offline')}</p>}
        <button className="primary" onClick={onExit}>
          {t('order.done')}
        </button>
      </main>
    );
  }

  const ended = flow.phase === 'expired' || flow.phase === 'closed';
  const cancellable = [
    'ready',
    'failed',
    'unavailable',
    'stuck',
    'qr',
  ].includes(flow.phase);

  return (
    <main className="panel narrow">
      {payments.testMode && <p className="ribbon">{t('pay.testMode')}</p>}
      {!online && (
        <p role="status" className="banner">
          {t('order.offline')}
        </p>
      )}
      <header className="orderhead">
        <div>
          <p className="muted">{t('order.number')}</p>
          <p className="number" data-testid="order-number">
            {order.orderNumber}
          </p>
        </div>
        <div>
          <p className="muted">{t('pay.total')}</p>
          <p className="amount">{total}</p>
        </div>
      </header>
      {!ended && secondsLeft !== null && (
        <p className="muted">
          {t('order.timeLeft')}:{' '}
          {secondsLeft > 0
            ? formatCountdown(secondsLeft)
            : t('order.timeChecking')}
        </p>
      )}

      {flow.phase === 'opening' && (
        <p role="status">{t('order.preparingPayment')}</p>
      )}

      {(flow.phase === 'ready' || flow.phase === 'card-processing') && (
        <section>
          <h2>{t('pay.choose')}</h2>
          {flow.phase === 'ready' && flow.message && (
            <p role="alert" className="error">
              {flow.message}
            </p>
          )}
          <CardField
            payments={payments}
            disabled={flow.phase === 'card-processing'}
          />
          <button
            className="primary"
            disabled={flow.phase === 'card-processing'}
            onClick={() => void controls.current?.payByCard()}
          >
            {flow.phase === 'card-processing'
              ? t('pay.processing')
              : t('pay.cardSubmit', { total })}
          </button>
          <button
            disabled={flow.phase === 'card-processing'}
            onClick={() => void controls.current?.payByPromptPay()}
          >
            {t('pay.promptPay')}
          </button>
        </section>
      )}

      {flow.phase === 'starting-qr' && (
        <p role="status">{t('pay.startingQr')}</p>
      )}

      {flow.phase === 'qr' && (
        <section className="center">
          <h2>{t('pay.scan')}</h2>
          <img className="qr" src={flow.qrImageUrl} alt={t('pay.qrAlt')} />
          <p role="status">{t('pay.waiting')}</p>
        </section>
      )}

      {flow.phase === 'failed' && (
        <section>
          <p role="alert" className="error">
            {flow.message ?? t('pay.failed')}
          </p>
          <button
            className="primary"
            onClick={() => void controls.current?.retry()}
          >
            {t('pay.tryAgain')}
          </button>
        </section>
      )}

      {flow.phase === 'unavailable' && (
        <section>
          <p role="alert" className="error">
            {t('pay.unavailable')}
          </p>
          <button
            className="primary"
            onClick={() => void controls.current?.retry()}
          >
            {t('pay.tryAgain')}
          </button>
        </section>
      )}

      {flow.phase === 'stuck' && (
        <p role="alert" className="error">
          {t('pay.stuck')}
        </p>
      )}

      {ended && (
        <section>
          <p role="alert" className="error">
            {flow.phase === 'expired' ? t('pay.expired') : t('pay.closed')}
          </p>
          <button className="primary" onClick={onExit}>
            {t('order.newOrder')}
          </button>
        </section>
      )}

      {cancelFailed && (
        <p role="alert" className="error">
          {t('order.cancelFailed')}
        </p>
      )}
      {cancellable && (
        <button onClick={() => void cancel()}>{t('order.cancel')}</button>
      )}
    </main>
  );
}
