import {
  connectBoard,
  createApiClient,
  createBoardController,
  initialBoard,
  preparingNumbers,
  readyNumbers,
  type BoardState,
} from '@cafepos/api-client';
import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export function App() {
  const [state, setState] = useState<BoardState>(initialBoard);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const api = createApiClient({ baseUrl: API_URL });
    const controller = createBoardController({
      socket: connectBoard(API_URL),
      fetchSnapshot: () => api.orders.board(),
      onChange: (s, c) => {
        setState(s);
        setConnected(c);
      },
      pollMs: 10_000,
    });
    controller.start();
    return () => controller.stop();
  }, []);

  const preparing = preparingNumbers(state);
  const ready = readyNumbers(state);

  return (
    <main className="board">
      <section className="col ready" aria-label="Ready for pickup">
        <h1>Ready</h1>
        <ul>{ready.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
      <section className="col preparing" aria-label="Being prepared">
        <h1>Preparing</h1>
        <ul>{preparing.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
      {state.truncated && <p className="banner">More orders are waiting than can be shown.</p>}
      {!connected && state.loaded && <p className="banner">Reconnecting… numbers may be out of date.</p>}
      {!state.loaded && <p className="banner">Loading…</p>}
    </main>
  );
}
