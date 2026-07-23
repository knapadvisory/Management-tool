import { io } from 'socket.io-client';
import { getToken } from './api.js';

let socket = null;
const readyListeners = new Set();

export function connectSocket() {
  if (socket) socket.disconnect();
  socket = io('/', { auth: { token: getToken() } });
  // Notify anyone waiting for the socket (e.g. components that mounted before
  // the connection was established) so they can attach their listeners.
  readyListeners.forEach((cb) => cb(socket));
  return socket;
}

export function getSocket() {
  return socket;
}

// Subscribe to socket (re)connections. Fires immediately if a socket already
// exists, and again each time a new one is created. Returns an unsubscribe fn.
export function onSocket(cb) {
  readyListeners.add(cb);
  if (socket) cb(socket);
  return () => readyListeners.delete(cb);
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
