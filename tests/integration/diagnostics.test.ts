import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { closeConnections } from '../../src/server/db/client';
import { channelDiagnostics, scrub } from '../../src/server/channels/diagnostics';

/**
 * The operator's view of the messaging path. What matters is that it answers
 * the two questions — is the platform delivering, are replies leaving — and
 * that nothing in it is a message, a customer or a credential.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

describe('channel diagnostics', () => {
  it('reports delivery and replies without customer data or tokens', async () => {
    // Not asking Instagram: a test does not call out to Meta.
    const report = await channelDiagnostics({ askPlatform: false });
    expect(report.inbound).toHaveProperty('last24h');
    for (const account of report.accounts) {
      expect(account).not.toHaveProperty('accessToken');
      expect(typeof account.hasToken).toBe('boolean');
      for (const row of account.recent) {
        expect(row).not.toHaveProperty('body');
        expect(row).not.toHaveProperty('recipientExternalId');
      }
    }
    expect(JSON.stringify(report)).not.toContain('test-token');
  });

  it('takes credentials out of platform errors', () => {
    const error = scrub(
      '401 {"error":{"message":"Invalid OAuth access token","fbtrace_id":"x"}} access_token=IGQWRabc123 IGAAabcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    );
    expect(error).toContain('Invalid OAuth access token');
    expect(error).not.toContain('IGQWRabc123');
    expect(error).not.toContain('IGAAabcdefghijklmnopqrstuvwxyz');
  });
});
