import type { DeviceStatus } from '@cafepos/api-client';
import { t } from '../i18n';

export function Blocked({ status }: { status: DeviceStatus }) {
  return (
    <main className="panel narrow center">
      <h1>
        {status === 'PAUSED' ? t('blocked.paused') : t('blocked.pending')}
      </h1>
    </main>
  );
}
