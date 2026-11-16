import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initEngine } from './engine/bot';
import { useStore } from './store/useStore';

// Theme must be on <html> before charts read the colour tokens.
document.documentElement.dataset.theme = useStore.getState().theme;
initEngine();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
