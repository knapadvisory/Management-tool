// Real-time fan-out helpers shared across routes.
//
// A change to a single client (a message, a document request, a shared file, a
// filing) needs to reach two audiences: the firm's staff (in the workspace
// room) and that client's portal users (in the per-client portal room). Keeping
// both emits behind one call means a new mutation site can't update one side
// and forget the other — the portal stays live by construction.

export const portalRoom = (clientId) => `portal:client:${clientId}`;

// Staff-side change to a client: refresh staff views AND the client's portal.
export function emitClientChanged(io, workspaceId, clientId) {
  if (!io) return;
  if (workspaceId) io.to(`workspace:${workspaceId}`).emit('clients:changed');
  if (clientId) io.to(portalRoom(clientId)).emit('portal:changed');
}

// A change that only the client's portal cares about (e.g. one portal contact
// acted and their co-contacts should see it live).
export function emitPortalChanged(io, clientId) {
  if (io && clientId) io.to(portalRoom(clientId)).emit('portal:changed');
}
