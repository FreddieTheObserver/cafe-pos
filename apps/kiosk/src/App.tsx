import { useEffect, useState } from 'react';
import type { KioskConfig } from './config';
import { useConnection } from './hooks';
import { t } from './i18n';
import { Kiosk } from './Kiosk';
import type { KioskPayments } from './payments';
import { Pairing } from './screens/Pairing';
import type { Stores } from './stores';

interface Props {
  config: KioskConfig;
  stores: Stores;
  payments: KioskPayments;
}

export function App({ config, stores, payments }: Props) {
  const [token, setToken] = useState(() => stores.deviceToken.get());
  const [notice, setNotice] = useState<string | null>(null);

  if (!token)
    return (
      <Pairing
        apiUrl={config.apiUrl}
        notice={notice}
        onPaired={(deviceToken) => {
          stores.deviceToken.set(deviceToken);
          setNotice(null);
          setToken(deviceToken);
        }}
      />
    );

  return (
    <Session
      key={token}
      config={config}
      token={token}
      stores={stores}
      payments={payments}
      onRevoked={() => {
        stores.deviceToken.clear();
        stores.activeOrder.clear();
        setNotice(t('pairing.revoked'));
        setToken(null);
      }}
    />
  );
}

interface SessionProps extends Props {
  token: string;
  onRevoked: () => void;
}

function Session({ config, token, stores, payments, onRevoked }: SessionProps) {
  const conn = useConnection(config.apiUrl, token);
  const revoked = conn?.feed.status === 'REVOKED';

  useEffect(() => {
    if (revoked) onRevoked();
  }, [revoked, onRevoked]);

  if (!conn) return <p className="center muted">{t('common.loading')}</p>;
  return (
    <Kiosk config={config} conn={conn} stores={stores} payments={payments} />
  );
}
