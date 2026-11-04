import { createRoot } from 'react-dom/client';
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@space/ui/styles.css';
import './gallery/gallery.css';
import { App } from './app/App.js';
import { AppProviders } from './app/AppProviders.js';

createRoot(document.getElementById('root')!).render(<AppProviders><App /></AppProviders>);
