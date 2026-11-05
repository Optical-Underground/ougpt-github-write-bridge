import { Octokit } from '@octokit/rest';

/**
 * Return a client for read-only GitHub verification requests.
 * Writes and merges must continue to use the primary authenticated client.
 * GH_TOKEN is used only in PAT mode and only for check/status reads.
 */
export function createVerificationClient({ primaryClient, authMode = 'pat', verificationToken, OctokitClass = Octokit }) {
  if (!primaryClient) throw new Error('primaryClient required');
  if (authMode !== 'pat' || !verificationToken) return primaryClient;
  return new OctokitClass({ auth: verificationToken });
}

export async function readGitHubVerification({ client, owner, repo, ref }) {
  const [checks, statuses] = await Promise.all([
    client.checks.listForRef({ owner, repo, ref, per_page: 100 }),
    client.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100 }),
  ]);
  return {
    checkRuns: checks.data.check_runs || [],
    combinedStatus: {
      state: statuses.data.state || 'none',
      total_count: statuses.data.total_count || statuses.data.statuses?.length || 0,
    },
  };
}
