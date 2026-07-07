import { io } from 'socket.io-client';
import { getToken } from './api.js';

let socket = null;

export function connectSocket() {
  if (socket) socket.disconnect();
  socket = io('/', { auth: { token: getToken() } });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
