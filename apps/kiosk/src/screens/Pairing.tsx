import { ApiError, createApiClient } from '@cafepos/api-client';
import { useState, type FormEvent } from 'react';
import { t } from '../i18n';

const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

interface Props {
  apiUrl: string;
  notice: string | null;
  onPaired: (deviceToken: string) => void;
}

export function Pairing({ apiUrl, notice, onPaired }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = code.replace(/\s+/g, '').toUpperCase();
    if (!CODE.test(normalized)) return setError(t('pairing.malformed'));
    setBusy(true);
    setError(null);
    try {
      const device = await createApiClient({
        baseUrl: apiUrl,
      }).devices.activate(normalized);
      onPaired(device.deviceToken);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410)
        setError(t('pairing.expired'));
      else if (err instanceof ApiError && err.status === 429)
        setError(t('pairing.rateLimited'));
      else if (err instanceof ApiError && err.status < 500)
        setError(t('pairing.invalid'));
      else setError(t('pairing.offline'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel narrow" onSubmit={submit}>
      <h1>{t('pairing.title')}</h1>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <p>{t('pairing.help')}</p>
      <label>
        {t('pairing.code')}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? t('pairing.working') : t('pairing.submit')}
      </button>
    </form>
  );
}
