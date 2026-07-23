import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, loadLocalTheme } from './theme.js';
import { applyPrefs } from './prefs.js';
import './styles.css';

// Apply the saved theme + preferences before first paint.
applyTheme(loadLocalTheme());
applyPrefs();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
