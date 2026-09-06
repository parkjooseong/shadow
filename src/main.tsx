import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './app/AppContext';
import { App } from './app/App';
import { CloudSyncProvider } from './features/account/CloudSyncProvider';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <CloudSyncProvider><App /></CloudSyncProvider>
    </AppProvider>
  </StrictMode>,
);
