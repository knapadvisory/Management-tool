import React, { useState } from 'react';
import FeeParserTool from './FeeParserTool.jsx';

// A hub for staff utilities. Add an entry here to surface a new tool; each
// opens in place with a back link to the list.
const TOOLS = [
  {
    id: 'marketplace-invoice-parser',
    name: 'Marketplace Invoice Parser',
    icon: '🧾',
    desc: 'Turn Amazon / Flipkart / Myntra / Nykaa fee PDFs into one reconciled Excel register, split by fee type with TDS sections mapped.',
    Component: FeeParserTool,
  },
];

export default function KnapTools() {
  const [activeId, setActiveId] = useState(null);
  const active = TOOLS.find((t) => t.id === activeId);

  if (active) {
    const Tool = active.Component;
    return (
      <div className="tools-page">
        <button className="btn btn-sm tools-back" onClick={() => setActiveId(null)}>← All KNAP Tools</button>
        <Tool />
      </div>
    );
  }

  return (
    <div className="tools-page">
      <div className="tools-head">
        <h2>🧰 KNAP Tools</h2>
        <p className="muted">Utilities for the practice. More tools will appear here.</p>
      </div>
      <div className="tools-grid">
        {TOOLS.map((t) => (
          <button key={t.id} className="tool-card" onClick={() => setActiveId(t.id)}>
            <span className="tool-card-icon">{t.icon}</span>
            <span className="tool-card-name">{t.name}</span>
            <span className="tool-card-desc">{t.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
