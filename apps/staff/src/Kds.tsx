import {
  ApiError,
  connectKds,
  createKdsController,
  initialKds,
  orderedTickets,
  type KdsState,
  type KdsTicket,
  type OrderStatus,
} from '@cafepos/api-client';
import { useEffect, useRef, useState } from 'react';
import { audioReady, chime, enableAudio } from './audio';
import { API_URL, api, session } from './session';

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  PAID: { to: 'IN_PREPARATION', label: 'Start' },
  IN_PREPARATION: { to: 'READY', label: 'Ready' },
  READY: { to: 'COMPLETED', label: 'Handed over' },
};

export function Kds({ onSignedOut }: { onSignedOut: () => void }) {
  const [state, setState] = useState<KdsState>(initialKds);
  const [connected, setConnected] = useState(false);
  const [sound, setSound] = useState(audioReady());
  const [message, setMessage] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const controller = createKdsController({
      socket: connectKds(API_URL, () => session.getToken() ?? ''),
      fetchSnapshot: () => api.kds.snapshot(),
      onChange: (s, c) => {
        setState(s);
        setConnected(c);
      },
      onNewOrder: () => chime(),
      onUnauthorized: () => {
        // The access token expired or was revoked: try a refresh, otherwise sign out.
        void session.refresh().then((ok) => (ok ? controller.start() : onSignedOut()));
      },
    });
    refreshRef.current = controller.refresh;
    controller.start();
    return () => controller.stop();
  }, [onSignedOut]);

  const advance = async (t: KdsTicket) => {
    const next = NEXT[t.status];
    if (!next) return;
    setMessage(null);
    try {
      await api.orders.transition(t.id, next.to);
    } catch (err) {
      setMessage(
        err instanceof ApiError
          ? `Order ${t.orderNumber}: ${err.message}`
          : 'Could not reach the server. Try again.',
      );
      // The ticket on screen may be stale (someone else moved it); reload.
      await refreshRef.current();
    }
  };

  const tickets = orderedTickets(state);

  return (
    <main className="kds">
      {!sound && (
        <button className="banner action" onClick={() => void enableAudio().then(setSound)}>
          Tap to turn on new-order sound
        </button>
      )}
      {!connected && state.loaded && <p className="banner">Offline — reconnecting. Orders may be missing.</p>}
      {state.truncated && <p className="banner">Showing the first {tickets.length} orders; more are waiting.</p>}
      {message && <p role="alert" className="banner error">{message}</p>}
      {state.loaded && tickets.length === 0 && <p className="center">No open orders.</p>}
      <ul className="tickets">
        {tickets.map((t) => {
          const next = NEXT[t.status];
          return (
            <li key={t.id} className={`ticket ${t.status}`}>
              <header>
                <strong>{t.orderNumber}</strong>
                <span>{t.status.replace('_', ' ')}</span>
              </header>
              {t.customerName && <p>{t.customerName}</p>}
              <ul>
                {t.items.map((l, i) => (
                  <li key={i}>
                    {l.quantity}× {l.nameSnapshot}
                    {l.options.length > 0 && <small> — {l.options.map((o) => o.name).join(', ')}</small>}
                    {l.notes && <em> “{l.notes}”</em>}
                  </li>
                ))}
              </ul>
              {next && <button onClick={() => void advance(t)}>{next.label}</button>}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
