import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'lism-css/main.css';
import { App } from './app';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing root');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
