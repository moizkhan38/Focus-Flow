import { getJiraCredentials, IntegrationNotConnectedError } from './credentialProvider.js';
import { createJiraClient } from './jiraService.js';

// Resolve an org's Jira client (Phase 2, step 2.5).
// Throws IntegrationNotConnectedError('jira') when the org hasn't connected
// Jira — route handlers surface that as 412 JIRA_NOT_CONNECTED via
// sendUpstreamError/the global error middleware.
export async function jiraClientFor(orgId) {
  const creds = await getJiraCredentials(orgId);
  if (!creds) throw new IntegrationNotConnectedError('jira');
  return createJiraClient(creds);
}
