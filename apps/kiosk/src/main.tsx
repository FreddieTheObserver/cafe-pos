import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readConfig } from './config';
import { createPayments } from './payments';
import { createStores } from './stores';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

try {
  const config = readConfig(import.meta.env);
  root.render(
    <StrictMode>
      <App
        config={config}
        stores={createStores(localStorage)}
        payments={createPayments(config)}
      />
    </StrictMode>,
  );
} catch (err) {
  root.render(
    <main className="panel narrow">
      <h1>This kiosk is not configured</h1>
      <p role="alert" className="error">
        {err instanceof Error ? err.message : String(err)}
      </p>
    </main>,
  );
}
