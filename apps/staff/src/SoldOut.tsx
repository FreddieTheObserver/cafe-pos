import { ApiError, type MenuItem } from '@cafepos/api-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from './session';

export function SoldOut() {
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.items.list());
      setError(null);
    } catch {
      setError('Could not load the menu.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const toggle = async (item: MenuItem) => {
    setPending(item.id);
    try {
      const updated = await api.items.setAvailability(item.id, !item.isAvailable);
      setItems((all) => all?.map((i) => (i.id === updated.id ? updated : i)) ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'Your role cannot change availability.' : 'Could not update. Try again.');
      await load();
    } finally {
      setPending(null);
    }
  };

  if (!items) return <p className="center">{error ?? 'Loading…'}</p>;

  return (
    <main className="soldout">
      {error && <p role="alert" className="banner error">{error}</p>}
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <span className={i.isAvailable ? '' : 'off'}>{i.name}</span>
            <button disabled={pending === i.id} aria-pressed={!i.isAvailable} onClick={() => void toggle(i)}>
              {i.isAvailable ? 'Mark sold out' : 'Back on sale'}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
