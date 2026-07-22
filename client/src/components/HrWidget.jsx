import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Compact HR & Payroll strip on the dashboard (admins only). Reads aggregate
// numbers from the KNAP-HRMS bridge — no salary or personal data. Clicking
// through opens the HR app via SSO.
export default function HrWidget({ onOpenHr }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ok | error

  useEffect(() => {
    let alive = true;
    api('/hr/summary')
      .then((d) => { if (alive) { setData(d); setState('ok'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

  if (state === 'error') return null; // HR down or unconfigured — stay quiet

  return (
    <button className="hr-widget" onClick={onOpenHr} title="Open HR & Payroll">
      <div className="hr-widget-head">
        <span className="hr-widget-title">👥 HR &amp; Payroll{data?.period ? ` · ${data.period}` : ''}</span>
        <span className="hr-widget-open">Open ↗</span>
      </div>
      {state === 'loading' ? (
        <div className="hr-widget-loading">Loading…</div>
      ) : (
        <div className="hr-widget-stats">
          <div className="hr-stat"><b>{data.headcount}</b><span>Employees</span></div>
          <div className="hr-stat"><b>{data.leave?.on_leave_today ?? 0}</b><span>On leave today</span></div>
          <div className={`hr-stat ${data.leave?.pending_approvals ? 'warn' : ''}`}><b>{data.leave?.pending_approvals ?? 0}</b><span>Leave approvals</span></div>
          <div className={`hr-stat ${data.payroll?.pending ? 'warn' : 'ok'}`}>
            <b>{data.payroll?.all_done ? '✓' : (data.payroll?.pending ?? 0)}</b>
            <span>{data.payroll?.all_done ? 'Payroll done' : 'Payroll pending'}</span>
          </div>
        </div>
      )}
    </button>
  );
}
