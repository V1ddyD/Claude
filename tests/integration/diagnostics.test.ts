import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { closeConnections } from '../../src/server/db/client';
import { channelDiagnostics, healthCheck, scrub } from '../../src/server/channels/diagnostics';
import { setChannelProvider, resetChannelProvider } from '../../src/server/channels/provider';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';

/**
 * The operator's view of the messaging path. What matters is that it answers
 * the two questions — is the platform delivering, are replies leaving — and
 * that nothing in it is a message, a customer or a credential.
 */

let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  resetChannelProvider();
  await admin?.end({ timeout: 5 });
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

describe('the hourly check', () => {
  async function queuedReply(status: 'queued' | 'failed', error: string | null): Promise<string> {
    const run = Math.random().toString(36).slice(2, 10);
    const [account] = await admin<{ id: string }[]>`
      INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name, access_token)
      VALUES (${SINCLAIR_TENANT_ID}, 'instagram', ${'health-' + run}, 'Health', 'test-token')
      RETURNING id`;
    const [conversation] = await admin<{ id: string }[]>`
      INSERT INTO conversations (tenant_id) VALUES (${SINCLAIR_TENANT_ID}) RETURNING id`;
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO channel_messages (tenant_id, channel, channel_account_id, conversation_id,
                                    recipient_external_id, body, dedupe_key, status, attempts, last_error,
                                    created_at, scheduled_for)
      VALUES (${SINCLAIR_TENANT_ID}, 'instagram', ${account!.id}, ${conversation!.id}, ${'igsid-' + run},
              'Hello', ${'health-' + run}, ${status}, 1, ${error},
              now() - interval '30 minutes', now() - interval '20 minutes')
      RETURNING id`;
    return row!.id;
  }

  it('delivers a reply that was stuck waiting for a retry', async () => {
    const id = await queuedReply('queued', '503 <h1>5xx Server Error</h1>');
    setChannelProvider({ name: 'ok', send: async () => ({ accepted: true, providerMessageId: 'mid.health' }) });

    const report = await healthCheck({ askPlatform: false });

    const [row] = await admin<{ status: string }[]>`SELECT status FROM channel_messages WHERE id = ${id}`;
    expect(row?.status).toBe('accepted');
    expect(report.repaired.repliesDelivered).toBeGreaterThanOrEqual(1);
    expect(report.problems.join(' ')).not.toMatch(/still waiting/);
  });

  it('reports a reply that could not be sent, in words an owner can act on', async () => {
    await queuedReply('failed', '400 access_token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH invalid');
    setChannelProvider({ name: 'ok', send: async () => ({ accepted: true, providerMessageId: 'mid.health2' }) });

    const report = await healthCheck({ askPlatform: false });

    expect(report.ok).toBe(false);
    const text = report.problems.join(' ');
    expect(text).toMatch(/could not be sent in the last 2 hours/);
    // Never a credential, even inside a platform error.
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
