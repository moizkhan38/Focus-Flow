// Shared Socket.io instance. Routes import `emit()` to broadcast events.
// The instance is set by server.js at startup.
let io = null;

export function setIo(instance) {
  io = instance;
}

/**
 * Room name for a project. MUST include the org id.
 *
 * Rooms used to be keyed on the Jira project key alone. The join handler checks
 * that the key belongs to the caller's org, but two different organizations can
 * legitimately own projects with the SAME key — 'SCRUM' and 'KAN' are Jira's own
 * defaults — and both would then join 'project:SCRUM' and receive each other's
 * realtime issue events. Scoping the room name makes that impossible regardless
 * of what the join handler allows.
 */
export function projectRoom(orgId, projectKey) {
  return `org:${orgId}:project:${projectKey}`;
}

/**
 * Broadcast an event to one org's project room.
 * If io isn't initialised (e.g., migration scripts), this is a no-op.
 */
export function emitToProject(orgId, projectKey, event, payload) {
  if (!io || !orgId || !projectKey) return;
  io.to(projectRoom(orgId, projectKey)).emit(event, payload);
}
