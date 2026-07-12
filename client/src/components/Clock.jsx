import React, { useEffect, useState } from 'react';
import { localeArg, dateOpts } from '../prefs.js';

// A live clock that respects the 24-hour, locale and time-zone preferences.
export default function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString(localeArg(), dateOpts({ hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const date = now.toLocaleDateString(localeArg(), dateOpts({ weekday: 'short', day: 'numeric', month: 'short' }));
  return (
    <div className="clock" title={Intl.DateTimeFormat().resolvedOptions().timeZone}>
      <span className="clock-time">{time}</span>
      <span className="clock-date muted">{date}</span>
    </div>
  );
}
