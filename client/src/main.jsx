import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, loadLocalTheme } from './theme.js';
import './styles.css';

// Apply the saved theme before first paint to avoid a flash of the wrong mode.
applyTheme(loadLocalTheme());

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
