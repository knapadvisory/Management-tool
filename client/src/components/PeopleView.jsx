import React, { useState } from 'react';
import TeamDirectory from './TeamDirectory.jsx';
import Collabs from './Collabs.jsx';

// Combines the Team directory and Collabs under one tab with a sub-tab switch.
export default function PeopleView({ user, users, onlineIds, collabs, onMessage, onRefresh, initialTab = 'team' }) {
  const [tab, setTab] = useState(initialTab === 'collabs' ? 'collabs' : 'team');
  return (
    <div className="people-view">
      <div className="files-tabs">
        <button className={`files-tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>👤 Team</button>
        <button className={`files-tab ${tab === 'collabs' ? 'active' : ''}`} onClick={() => setTab('collabs')}>👥 Collabs</button>
      </div>
      <div className="people-view-body">
        {tab === 'team'
          ? <TeamDirectory user={user} users={users} onlineIds={onlineIds} onMessage={onMessage} />
          : <Collabs user={user} users={users} collabs={collabs} onlineIds={onlineIds} onRefresh={onRefresh} />}
      </div>
    </div>
  );
}
