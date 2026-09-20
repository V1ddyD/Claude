import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { setModelClient } from '../../src/server/ai/client';
import { receiveChannelMessage } from '../../src/server/channels/inbound';
import {
  connectChannelAccount, listChannelAccounts, disconnectChannelAccount,
} from '../../src/server/channels/accounts';
import { drainChannelOutbox } from '../../src/server/channels/outbox';
import {
  setChannelProvider, resetChannelProvider,
  type ChannelProvider, type ChannelSendResult, type OutgoingChannelMessage,
} from '../../src/server/channels/provider';

/**
 * A conversation arriving from Instagram rather than from a browser.
 *
 * The property under test is that it is the SAME conversation: the same rows,
 * the same assistant, the same lead pipeline. What a channel adds is three
 * answers a webhook cannot inherit — which dealership, which person, where the
 * reply goes — and everything asserted here is about those three.
 */

let admin: Sql;

const ACCOUNT = '17841400000000000';
const SENDER = 'igsid-4815162342';

class RecordingProvider implements ChannelProvider {
  readonly name = 'recording';
  readonly sent: OutgoingChannelMessage[] = [];
  private counter = 0;

  constructor(private readonly outcome: ChannelSendResult | ((n: number) => ChannelSendResult)) {}

  async send(message: OutgoingChannelMessage): Promise<ChannelSendResult> {
    this.sent.push(message);
    this.counter++;
    return typeof this.outcome === 'function' ? this.outcome(this.counter) : this.outcome;
  }
}

async function connectAccount(): Promise<string> {
  const rows = await admin<{ id: string }[]>`
    INSERT INTO channel_accounts (tenant_id, channel, external_account_id, display_name, access_token)
    VALUES (${SINCLAIR_TENANT_ID}, 'instagram', ${ACCOUNT}, 'Sinclair Motors', 'test-token')
    ON CONFLICT (channel, external_account_id) DO UPDATE SET is_active = true
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Fresh ids per case AND per run.
 *
 * Per case so two cases cannot dedup each other. Per RUN because the test
 * database outlives the run: an inbound message id is claimed forever by
 * design, and a sender keeps their visitor — so ids that repeat between runs
 * make every case after the first see itself as a redelivery of yesterday.
 */
const RUN = Math.random().toString(36).slice(2, 10);
let seq = 0;
const nextIds = () => {
  seq++;
  return { sender: `${SENDER}-${RUN}-${seq}`, mid: `mid.${RUN}.${seq}` };
};

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
  await connectAccount();
});

afterEach(() => {
  setModelClient(null);
  resetChannelProvider();
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('an inbound direct message', () => {
  it('answers, and queues the answer rather than claiming it was sent', async () => {
    setModelClient(new ScriptedModel([{ text: 'We have the S5 in stock. Want to see it?' }]));
    const { sender, mid } = nextIds();

    const outcome = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: mid,
      text: 'do you have the S5?',
      requestId: 'test',
    });

    expect(outcome.status).toBe('replied');
    if (outcome.status !== 'replied') return;

    const [conversation] = await admin<{ channel: string; visitor_id: string }[]>`
      SELECT channel, visitor_id FROM conversations WHERE id = ${outcome.conversationId}
    `;
    expect(conversation?.channel).toBe('instagram');
    // A platform sender is a visitor, not a customer: it is neither an email
    // address nor a phone number, so it cannot identify a person.
    expect(conversation?.visitor_id).toBeTruthy();

    const queued = await admin<{ status: string; body: string; recipient_external_id: string }[]>`
      SELECT status, body, recipient_external_id FROM channel_messages
      WHERE conversation_id = ${outcome.conversationId}
    `;
    expect(queued).toHaveLength(1);
    // Queued, not accepted. Nothing may report a reply as sent before the
    // platform has said so — the same rule the email outbox enforces.
    expect(queued[0]?.status).toBe('queued');
    expect(queued[0]?.recipient_external_id).toBe(sender);
  });

  it('is ignored when the account belongs to no dealership', async () => {
    setModelClient(new ScriptedModel([{ text: 'should never be reached' }]));
    const { sender, mid } = nextIds();

    const outcome = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: 'an-account-we-do-not-serve',
      externalUserId: sender,
      externalMessageId: mid,
      text: 'hello?',
      requestId: 'test',
    });

    // Never a guess at which dealership was probably meant: answering with
    // the wrong business's data is the one failure that must not happen.
    expect(outcome.status).toBe('unknown_account');
  });

  it('answers a redelivery once, not twice', async () => {
    setModelClient(new ScriptedModel([{ text: 'first' }, { text: 'second' }]));
    const { sender, mid } = nextIds();

    const message = {
      channel: 'instagram' as const,
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: mid,
      text: 'still there?',
      requestId: 'test',
    };

    const first = await receiveChannelMessage(message);
    const second = await receiveChannelMessage(message);

    expect(first.status).toBe('replied');
    // Meta redelivers anything it did not get a prompt 200 from, and a
    // redelivery is indistinguishable from a new message except by its id.
    expect(second.status).toBe('duplicate');

    if (first.status !== 'replied') return;
    const queued = await admin<{ count: number }[]>`
      SELECT count(*)::int FROM channel_messages WHERE conversation_id = ${first.conversationId}
    `;
    expect(queued[0]?.count).toBe(1);
  });

  it('continues the same conversation when the same person writes again', async () => {
    setModelClient(new ScriptedModel([{ text: 'one' }, { text: 'two' }]));
    const { sender } = nextIds();

    const first = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: `mid.a.${RUN}.${seq}`,
      text: 'what colours does it come in?',
      requestId: 'test',
    });

    const second = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: `mid.b.${RUN}.${seq}`,
      text: 'and the price?',
      requestId: 'test',
    });

    expect(first.status).toBe('replied');
    expect(second.status).toBe('replied');
    if (first.status !== 'replied' || second.status !== 'replied') return;

    // A DM thread has no page load to open a conversation. The thread itself
    // is the continuity, or the customer is asked everything twice.
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('says nothing when a person has taken the thread over', async () => {
    setModelClient(new ScriptedModel([{ text: 'hello' }, { text: 'the assistant butting in' }]));
    const { sender } = nextIds();

    const opened = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: `mid.h1.${RUN}.${seq}`,
      text: 'can I speak to someone?',
      requestId: 'test',
    });
    expect(opened.status).toBe('replied');
    if (opened.status !== 'replied') return;

    await admin`
      UPDATE conversations SET status = 'handed_off', handed_off_at = now()
      WHERE id = ${opened.conversationId}
    `;

    const after = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: `mid.h2.${RUN}.${seq}`,
      text: 'are you there?',
      requestId: 'test',
    });

    expect(after.status).toBe('handed_off');

    // The customer's words are still recorded — they are theirs, and staff
    // need to see them — but no reply is queued on top of the salesperson.
    const messages = await admin<{ role: string; content: string }[]>`
      SELECT role, content FROM messages
      WHERE conversation_id = ${opened.conversationId} ORDER BY seq DESC LIMIT 1
    `;
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('are you there?');

    const queued = await admin<{ count: number }[]>`
      SELECT count(*)::int FROM channel_messages WHERE conversation_id = ${opened.conversationId}
    `;
    expect(queued[0]?.count).toBe(1);
  });
});

describe('the outbound outbox', () => {
  it('only marks a reply accepted when the platform accepts it', async () => {
    setModelClient(new ScriptedModel([{ text: 'On its way.' }]));
    const { sender, mid } = nextIds();

    const outcome = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: mid,
      text: 'anything in silver?',
      requestId: 'test',
    });
    expect(outcome.status).toBe('replied');
    if (outcome.status !== 'replied') return;

    const provider = new RecordingProvider({ accepted: true, providerMessageId: 'mid.sent.1' });
    setChannelProvider(provider);

    await drainChannelOutbox(SINCLAIR_TENANT_ID);

    const [row] = await admin<{ status: string; provider_message_id: string }[]>`
      SELECT status, provider_message_id FROM channel_messages
      WHERE conversation_id = ${outcome.conversationId}
    `;
    expect(row?.status).toBe('accepted');
    expect(row?.provider_message_id).toBe('mid.sent.1');

    // Sent AS the dealership's own account, with the dealership's own token:
    // a reply going out from another tenant's Instagram is the cross-tenant
    // failure this table exists to prevent.
    const sent = provider.sent.find((m) => m.recipientExternalId === sender);
    expect(sent?.senderExternalId).toBe(ACCOUNT);
    expect(sent?.accessToken).toBe('test-token');
  });

  it('marks a closed 24-hour window expired rather than retrying forever', async () => {
    setModelClient(new ScriptedModel([{ text: 'Replying a day late.' }]));
    const { sender, mid } = nextIds();

    const outcome = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: ACCOUNT,
      externalUserId: sender,
      externalMessageId: mid,
      text: 'sorry, was away',
      requestId: 'test',
    });
    expect(outcome.status).toBe('replied');
    if (outcome.status !== 'replied') return;

    setChannelProvider(
      new RecordingProvider({
        accepted: false,
        // Meta's own code for "the window has closed".
        error: '400 {"error":{"code":10,"error_subcode":2534022}}',
        retryable: false,
      }),
    );

    await drainChannelOutbox(SINCLAIR_TENANT_ID);

    const [row] = await admin<{ status: string }[]>`
      SELECT status FROM channel_messages WHERE conversation_id = ${outcome.conversationId}
    `;
    // Its own state, not 'failed': the thread went cold because the customer
    // went quiet for a day, which is not an outage and not our bug. Retrying
    // cannot succeed — the window only reopens when they write again.
    expect(row?.status).toBe('expired');
  });
});

describe('connecting an account', () => {
  /** Its own account id per case, so cases cannot collide on the global key. */
  const account = (suffix: string) => `${ACCOUNT}-${RUN}-${suffix}`;

  it('is what makes a webhook resolvable at all', async () => {
    setModelClient(new ScriptedModel([{ text: 'Connected and answering.' }]));
    const id = account('new');
    const { sender, mid } = nextIds();

    const before = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: id,
      externalUserId: sender,
      externalMessageId: `${mid}.before`,
      text: 'anyone there?',
      requestId: 'test',
    });
    // Nobody owns it yet, so the message belongs to no dealership.
    expect(before.status).toBe('unknown_account');

    await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'token-from-meta',
      displayName: 'Sinclair Motors',
    });

    const after = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: id,
      externalUserId: sender,
      externalMessageId: `${mid}.after`,
      text: 'anyone there?',
      requestId: 'test',
    });
    expect(after.status).toBe('replied');
  });

  it('replaces the token when the same account reconnects', async () => {
    const id = account('refresh');

    const first = await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'the-old-token',
    });

    // Instagram's long-lived token lasts 60 days, so reconnecting is the
    // normal case, not an error. If it failed, the only way to refresh a
    // token would be to delete the account and its history with it.
    const second = await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'the-new-token',
      expiresInSeconds: 60 * 24 * 60 * 60,
    });

    expect(second.id).toBe(first.id);
    expect(second.tokenExpiresAt).toBeInstanceOf(Date);

    const [row] = await admin<{ access_token: string }[]>`
      SELECT access_token FROM channel_accounts WHERE id = ${first.id}
    `;
    expect(row?.access_token).toBe('the-new-token');
  });

  it('refuses an account another dealership already holds', async () => {
    const id = account('contested');

    await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'sinclair-token',
    });

    // The unique key is global, so without the tenant predicate on the upsert
    // this would silently hand Sinclair's Instagram account to Northwind —
    // who would then answer Sinclair's customers with Northwind's cars.
    await expect(
      connectChannelAccount({
        tenantId: NORTHWIND_TENANT_ID,
        channel: 'instagram',
        externalAccountId: id,
        accessToken: 'northwind-token',
      }),
    ).rejects.toThrow(/another tenant/);

    const [row] = await admin<{ tenant_id: string; access_token: string }[]>`
      SELECT tenant_id, access_token FROM channel_accounts
      WHERE channel = 'instagram' AND external_account_id = ${id}
    `;
    expect(row?.tenant_id).toBe(SINCLAIR_TENANT_ID);
    expect(row?.access_token).toBe('sinclair-token');
  });

  it('never hands back the token it was given', async () => {
    const id = account('opaque');

    const connected = await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'a-secret-token',
    });

    // A response body ends up in logs, proxies and terminal scrollback.
    expect(JSON.stringify(connected)).not.toContain('a-secret-token');

    const listed = await listChannelAccounts(SINCLAIR_TENANT_ID);
    expect(JSON.stringify(listed)).not.toContain('a-secret-token');
    expect(listed.find((a) => a.externalAccountId === id)?.hasToken).toBe(true);
  });

  it('stops answering once disconnected', async () => {
    setModelClient(new ScriptedModel([{ text: 'should not be reached' }]));
    const id = account('gone');
    const { sender, mid } = nextIds();

    await connectChannelAccount({
      tenantId: SINCLAIR_TENANT_ID,
      channel: 'instagram',
      externalAccountId: id,
      accessToken: 'token-to-revoke',
    });

    expect(await disconnectChannelAccount(SINCLAIR_TENANT_ID, 'instagram', id)).toBe(true);

    const outcome = await receiveChannelMessage({
      channel: 'instagram',
      externalAccountId: id,
      externalUserId: sender,
      externalMessageId: mid,
      text: 'hello?',
      requestId: 'test',
    });
    expect(outcome.status).toBe('unknown_account');

    // Deactivated, not deleted: the conversations it carried are still the
    // dealership's, and a row that vanishes takes the explanation with it.
    const [row] = await admin<{ is_active: boolean; access_token: string | null }[]>`
      SELECT is_active, access_token FROM channel_accounts
      WHERE channel = 'instagram' AND external_account_id = ${id}
    `;
    expect(row?.is_active).toBe(false);
    expect(row?.access_token).toBeNull();
  });
});
