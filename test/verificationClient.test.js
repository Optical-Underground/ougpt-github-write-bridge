import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationClient, readGitHubVerification } from '../src/verificationClient.js';

test('uses separate token only in PAT mode', () => {
  const primary = { id: 'primary' };
  class FakeOctokit { constructor(options) { this.auth = options.auth; } }
  assert.equal(createVerificationClient({ primaryClient: primary, authMode: 'app', verificationToken: 'secret', OctokitClass: FakeOctokit }), primary);
  assert.equal(createVerificationClient({ primaryClient: primary, authMode: 'pat', OctokitClass: FakeOctokit }), primary);
  const client = createVerificationClient({ primaryClient: primary, authMode: 'pat', verificationToken: 'secret', OctokitClass: FakeOctokit });
  assert.equal(client.auth, 'secret');
});

test('fails closed without primary client', () => {
  assert.throws(() => createVerificationClient({}), /primaryClient required/);
});

test('reads checks and statuses without invoking any write API', async () => {
  const calls = [];
  const client = {
    checks: { listForRef: async (args) => { calls.push(['checks', args]); return { data: { check_runs: [{ conclusion: 'success' }] } }; } },
    repos: { getCombinedStatusForRef: async (args) => { calls.push(['statuses', args]); return { data: { state: 'success', total_count: 1 } }; } },
  };
  const result = await readGitHubVerification({ client, owner: 'Optical-Underground', repo: 'pos-for-optical', ref: 'abc' });
  assert.equal(result.checkRuns.length, 1);
  assert.equal(result.combinedStatus.state, 'success');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, args]) => args.ref === 'abc'));
});
