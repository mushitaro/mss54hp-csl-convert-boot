import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './pwa';
import './globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

/* Registration is wired before render, but the worker only ever reports an update through this
   flag - it is never allowed to activate over a running page. See pwa.ts. */
let onUpdate: () => void = () => {};
registerServiceWorker(() => onUpdate());

createRoot(root).render(
    <StrictMode>
        <App onUpdateAvailable={(handler) => { onUpdate = handler; }} />
    </StrictMode>,
);
