import { getGithubToken, IntegrationNotConnectedError } from './credentialProvider.js';
import { createGithubClient } from './githubService.js';

// Resolve an org's GitHub client (Phase 2, step 2.6).
// Throws IntegrationNotConnectedError('github') when the org hasn't connected
// GitHub — route handlers surface that as 412 GITHUB_NOT_CONNECTED via
// sendServerError/sendUpstreamError.
export async function githubClientFor(orgId) {
  const token = await getGithubToken(orgId);
  if (!token) throw new IntegrationNotConnectedError('github');
  return createGithubClient(token);
}
