import { createRoot } from 'react-dom/client';
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@space/ui/styles.css';
import './gallery/gallery.css';
import { App } from './app/App.js';
import { AppProviders } from './app/AppProviders.js';

if (window.self !== window.top && new URLSearchParams(location.search).get('view') === 'split') {
  document.documentElement.classList.add('space-split-document');
}

createRoot(document.getElementById('root')!).render(<AppProviders><App /></AppProviders>);
