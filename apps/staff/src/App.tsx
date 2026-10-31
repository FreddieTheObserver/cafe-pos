import { ApiError } from '@cafepos/api-client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Kds } from './Kds';
import { SoldOut } from './SoldOut';
import { session } from './session';

type Screen = 'kitchen' | 'soldout';

export function App() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [screen, setScreen] = useState<Screen>('kitchen');

  useEffect(() => {
    void session.restore().then((ok) => {
      setSignedIn(ok);
      setReady(true);
    });
  }, []);

  const signedOut = useCallback(() => setSignedIn(false), []);

  if (!ready) return <p className="center">Loading…</p>;
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  const signOut = () => void session.logout().then(() => setSignedIn(false));

  return (
    <div className="shell">
      <nav>
        <button aria-pressed={screen === 'kitchen'} onClick={() => setScreen('kitchen')}>Kitchen</button>
        <button aria-pressed={screen === 'soldout'} onClick={() => setScreen('soldout')}>Sold out</button>
        <span className="grow" />
        <button onClick={signOut}>Sign out</button>
      </nav>
      {screen === 'kitchen' ? <Kds onSignedOut={signedOut} /> : <SoldOut />}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await session.login(String(form.get('email')), String(form.get('password')));
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Email or password is wrong.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Wait a moment and try again.'
            : 'Could not reach the server.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>Staff sign in</h1>
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
