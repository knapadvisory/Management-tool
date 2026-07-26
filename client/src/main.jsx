import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ClientPortal from './ClientPortal.jsx';
import { applyTheme, loadLocalTheme } from './theme.js';
import { applyPrefs } from './prefs.js';
import './styles.css';

// The client portal is a separate, externally-facing app on the same bundle;
// it runs on its own portal session token and never touches the staff app.
const isPortal = window.location.pathname.startsWith('/portal');
if (!isPortal) {
  // Apply the saved theme + preferences before first paint (staff app only).
  applyTheme(loadLocalTheme());
  applyPrefs();
}

ReactDOM.createRoot(document.getElementById('root')).render(isPortal ? <ClientPortal /> : <App />);
