/**
 * Entry point — renders the App component into the DOM.
 */
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './services/offlineMap'

// Offline map and app shell (production builds; the dev server reloads too often)
if (import.meta.env.PROD) registerServiceWorker()

createRoot(document.getElementById('root')!).render(<App />)
