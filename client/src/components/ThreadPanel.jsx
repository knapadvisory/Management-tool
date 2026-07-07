import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import Message from './Message.jsx';
import MessageComposer from './MessageComposer.jsx';

export default function ThreadPanel({ channel, rootId, currentUser, members, onClose }) {
  const [root, setRoot] = useState(null);
  const [replies, setReplies] = useState([]);

  async function load() {
    const d = await api(`/channels/${channel.id}/messages/${rootId}/thread`);
    setRoot(d.root);
    setReplies(d.replies);
  }

  useEffect(() => { load(); }, [channel.id, rootId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onNew = ({ message }) => {
      if (message.parent_id === rootId) setReplies((r) => (r.some((x) => x.id === message.id) ? r : [...r, message]));
      if (message.id === rootId) setRoot(message);
    };
    const onUpdated = ({ message }) => {
      if (message.id === rootId) setRoot((prev) => ({ ...message, mine: undefined }));
      setReplies((r) => r.map((x) => (x.id === message.id ? message : x)));
    };
    socket.on('message:new', onNew);
    socket.on('message:updated', onUpdated);
    return () => { socket.off('message:new', onNew); socket.off('message:updated', onUpdated); };
  }, [rootId]);

  return (
    <aside className="thread-panel">
      <header className="thread-header">
        <strong>Thread</strong>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </header>
      <div className="thread-body">
        {root && (
          <Message message={root} currentUser={currentUser} channelId={channel.id} inThread />
        )}
        <div className="thread-divider">
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </div>
        {replies.map((m, i) => (
          <Message
            key={m.id}
            message={m}
            currentUser={currentUser}
            channelId={channel.id}
            inThread
            grouped={i > 0 && replies[i - 1].user_id === m.user_id}
          />
        ))}
      </div>
      <MessageComposer channel={channel} members={members} parentId={rootId} placeholder="Reply…" autoFocus />
    </aside>
  );
}
