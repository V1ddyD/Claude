import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  channelAccounts, channelIdentities, conversations, customers, type MessagingChannel,
} from '@/server/db/schema';
import { checkRateLimit } from '@/server/services/limits';
import { channelProvider, type ChannelProfile } from './provider';
import { findLeadForConversation, upsertLead } from '@/server/services/leads';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { respondToMessage } from '@/server/ai/conversation';
import { enqueue } from '@/server/jobs';
import { claimInboundMessage, resolveChannelAccount, resolveChannelIdentity } from './identity';
import { queueChannelMessage } from './outbox';

/**
 * A message arriving from a messaging channel.
 *
 * This is the whole of what a DM adds. It answers the three questions a
 * webhook cannot inherit from a browser — which dealership, which person,
 * where does the reply go — and then hands over to exactly the same
 * conversation loop the website uses. There is no second assistant, no second
 * set of tools and no second data path.
 */

export type InboundOutcome =
  /** Already processed. Meta redelivers; this is the common, boring case. */
  | { status: 'duplicate' }
  /** A webhook for an account we do not serve. Acknowledged, not guessed at. */
  | { status: 'unknown_account' }
  /** Nothing to reply to — a reaction, a read receipt, an empty payload. */
  | { status: 'ignored'; reason: string }
  /** Too many messages from one sender. Dropped without a reply. */
  | { status: 'rate_limited' }
  /** A person has the thread. Recorded, no reply sent. */
  | { status: 'handed_off'; conversationId: string }
  | { status: 'replied'; conversationId: string; text: string };

export interface InboundChannelMessage {
  channel: MessagingChannel;
  /** The business account the message was sent TO. */
  externalAccountId: string;
  /** The person who sent it, in the platform's own terms. */
  externalUserId: string;
  externalMessageId: string;
  text: string;
  displayName?: string | null;
  requestId: string;
}

/**
 * How long a quiet thread stays the same conversation.
 *
 * Matched to the platform's own 24-hour messaging window rather than chosen:
 * inside it the exchange is one continuous conversation to the customer, and
 * outside it they have had a day away and are starting again. Threading
 * everything together forever would carry a stale budget and a stale car into
 * a conversation about something else entirely.
 */
const THREAD_WINDOW_HOURS = 24;

/**
 * The longest message the assistant will read.
 *
 * The same ceiling as the website's chat endpoint. Anything longer is not a
 * question about a car, and storing and scanning it costs the dealership for
 * somebody else's amusement.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * How fast one person may write.
 *
 * The website has a limit; this path had none. Every inbound DM produces a
 * reply, every reply is a call against the account's Instagram quota — two
 * hundred an hour — and one person pasting in a loop could spend all of it,
 * leaving every real customer that hour unanswered.
 *
 * Generous on purpose. People send three short messages where one long one
 * would do, and a limit a genuine customer can hit is a bug of its own.
 */
const PER_MINUTE = 12;
const PER_HOUR = 90;

/**
 * Made safe to store and scan.
 *
 * Control characters are removed rather than escaped: they have no place in a
 * message about a car, and some of them change how text renders in the portal
 * or in a log line. Whitespace runs are kept as line breaks, because people do
 * write lists.
 */
export function sanitiseInbound(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

export async function receiveChannelMessage(
  message: InboundChannelMessage,
): Promise<InboundOutcome> {
  const text = sanitiseInbound(message.text);
  if (!text) return { status: 'ignored', reason: 'no text' };

  // Claimed BEFORE any work: a redelivery that arrives while the first copy is
  // still being answered must not produce a second reply.
  if (!(await claimInboundMessage(message.channel, message.externalMessageId))) {
    return { status: 'duplicate' };
  }

  const account = await resolveChannelAccount(message.channel, message.externalAccountId);
  if (!account) return { status: 'unknown_account' };

  // Before any tenant work at all. A sender over the limit costs one counter
  // increment and nothing else: no rows, no reply, no platform call.
  if (!(await withinRateLimit(account.channelAccountId, message.externalUserId))) {
    return { status: 'rate_limited' };
  }

  // Who they are, looked up once per person and OUTSIDE the transaction: it
  // is a network call to Meta, and holding a database transaction open across
  // one is how a slow API becomes a slow database.
  const label = await senderLabel(account, message);

  // Identity, conversation and the scoring job in ONE transaction, so a
  // conversation always has the visitor it belongs to and is always queued for
  // scoring — the same reasoning as the chat endpoint, where a client that
  // disconnects mid-stream still leaves a lead to be scored.
  const session = await withTenant(account.tenantId, async (db) => {
    const identity = await resolveChannelIdentity(db, {
      channel: message.channel,
      externalUserId: message.externalUserId,
      displayName: label?.stored ?? null,
    });

    const conversationId = await openChannelConversation(db, {
      visitorId: identity.visitorId,
      customerId: identity.customerId,
      channel: message.channel,
    });

    await openChannelLead(db, {
      conversationId,
      channel: message.channel,
      externalUserId: message.externalUserId,
      label,
      customerId: identity.customerId,
    });

    await enqueue(db, 'extract_and_score', { conversationId });
    return { visitorId: identity.visitorId, conversationId };
  });

  const reply = await respondToMessage({
    tenantId: account.tenantId,
    conversationId: session.conversationId,
    visitorId: session.visitorId,
    userMessage: text,
    requestId: message.requestId,
  });

  if (reply.mode === 'handed_off') {
    return { status: 'handed_off', conversationId: session.conversationId };
  }

  // Nothing to send is not an error, and it is not something to paper over
  // with a filler sentence either. A silent turn is visible in the portal.
  if (!reply.text.trim()) {
    return { status: 'ignored', reason: 'assistant produced no text' };
  }

  await withTenant(account.tenantId, async (db) => {
    await queueChannelMessage(db, {
      channel: message.channel,
      channelAccountId: account.channelAccountId,
      conversationId: session.conversationId,
      recipientExternalId: message.externalUserId,
      body: reply.text,
    });
    await enqueue(db, 'send_channel_message', {});
  });

  return { status: 'replied', conversationId: session.conversationId, text: reply.text };
}

/**
 * A lead, from the first message, before anybody gives an email address.
 *
 * On the website an unidentified visitor deliberately produces no lead: a
 * browser who types a question and leaves is someone staff cannot act on, and
 * a portal full of those is a portal nobody opens.
 *
 * A direct message is not that. The handle IS a way to reach them — the
 * salesperson can open Instagram and reply — so "anonymous" is simply untrue
 * here, and the reason for withholding the lead does not apply. A dealership
 * wants to know that somebody asked about the S5 at eleven at night, and to be
 * able to answer them in the morning.
 *
 * The customer record carries the handle and no email, which is honest: it is
 * exactly what we know. An email later, through a booking, merges into the
 * same conversation's lead rather than starting a second one.
 */
async function openChannelLead(
  db: TenantDb,
  params: {
    conversationId: string;
    channel: MessagingChannel;
    externalUserId: string;
    label: SenderLabel | null;
    customerId: string | null;
  },
): Promise<void> {
  // A customer who wrote before names could be looked up has a row with no
  // name on it. Filled in the first time we learn one, and never over a name
  // they gave us themselves.
  if (params.customerId && params.label) {
    await db
      .update(customers)
      .set({ fullName: params.label.customerName })
      .where(
        and(
          eq(customers.tenantId, db.tenantId),
          eq(customers.id, params.customerId),
          sql`${customers.fullName} IS NULL`,
        ),
      );
  }

  if (await findLeadForConversation(db, params.conversationId)) return;

  let customerId = params.customerId;

  if (!customerId) {
    // Named by their handle where we have one. Never invented: a customer row
    // with a plausible-looking name nobody gave us is worse than a blank.
    const created = await db
      .insert(customers)
      .values({
        tenantId: db.tenantId,
        fullName: params.label?.customerName ?? null,
        consentSource: params.channel,
      })
      .returning({ id: customers.id });

    customerId = created[0]!.id;

    await db
      .update(channelIdentities)
      .set({ customerId })
      .where(
        and(
          eq(channelIdentities.tenantId, db.tenantId),
          eq(channelIdentities.channel, params.channel),
          eq(channelIdentities.externalUserId, params.externalUserId),
        ),
      );
  }

  // The source says where it came from, so the portal can show a salesperson
  // that this one is answered by opening Instagram rather than by ringing.
  await upsertLead(db, {
    conversationId: params.conversationId,
    customerId,
    source: params.channel,
  });
}

/**
 * The conversation this message belongs to.
 *
 * A DM thread has no equivalent of a page load, so there is nothing to open a
 * conversation the way the website does. The thread itself is the continuity:
 * a recent, open conversation for this visitor on this channel is the one they
 * are still having.
 */
async function openChannelConversation(
  db: TenantDb,
  params: { visitorId: string; customerId: string | null; channel: MessagingChannel },
): Promise<string> {
  const cutoff = new Date(Date.now() - THREAD_WINDOW_HOURS * 60 * 60 * 1000);

  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, db.tenantId),
        eq(conversations.visitorId, params.visitorId),
        eq(conversations.channel, params.channel),
        gt(conversations.lastMessageAt, cutoff),
        sql`${conversations.status} <> 'closed'`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const created = await db
    .insert(conversations)
    .values({
      tenantId: db.tenantId,
      visitorId: params.visitorId,
      customerId: params.customerId,
      channel: params.channel,
    })
    .returning({ id: conversations.id });

  return created[0]!.id;
}

/** Both a sliding minute and a sliding hour, so a burst and a slow drip are both caught. */
async function withinRateLimit(channelAccountId: string, externalUserId: string): Promise<boolean> {
  // Hashed: the limiter's table is not tenant-scoped, and a platform user id
  // is not something it needs to hold in the clear.
  const subject = createHash('sha256')
    .update(`${channelAccountId}|${externalUserId}`)
    .digest('hex')
    .slice(0, 32);

  const [minute, hour] = await Promise.all([
    checkRateLimit({ bucket: 'channel-minute', subject, max: PER_MINUTE, windowSeconds: 60 }),
    checkRateLimit({ bucket: 'channel-hour', subject, max: PER_HOUR, windowSeconds: 3600 }),
  ]);
  return minute.allowed && hour.allowed;
}

interface SenderLabel {
  /** What goes on the channel identity: the handle, or failing that the name. */
  stored: string;
  /** What a salesperson sees on the lead until the customer gives their own. */
  customerName: string;
}

/**
 * The sender, in words a salesperson can use.
 *
 * Taken from the webhook when it carries a username, which today it does not,
 * and otherwise from the platform's profile endpoint — but only the first time:
 * a sender whose identity already has a name is not looked up again.
 */
async function senderLabel(
  account: { tenantId: string; channelAccountId: string },
  message: InboundChannelMessage,
): Promise<SenderLabel | null> {
  if (message.displayName) return labelFrom({ handle: message.displayName });

  const known = await withTenant(account.tenantId, async (db) => {
    const [identity] = await db
      .select({ displayName: channelIdentities.displayName })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.tenantId, db.tenantId),
          eq(channelIdentities.channel, message.channel),
          eq(channelIdentities.externalUserId, message.externalUserId),
        ),
      )
      .limit(1);
    if (identity?.displayName) return { name: identity.displayName, token: null };

    const [row] = await db
      .select({ token: channelAccounts.accessToken })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, db.tenantId),
          eq(channelAccounts.id, account.channelAccountId),
        ),
      )
      .limit(1);
    return { name: null, token: row?.token ?? null };
  });

  if (known.name) return null;
  if (!known.token) return null;

  const provider = channelProvider();
  const profile = provider.fetchProfile
    ? await provider.fetchProfile({
        channel: message.channel,
        externalUserId: message.externalUserId,
        accessToken: known.token,
      })
    : null;

  return profile ? labelFrom(profile) : null;
}

function labelFrom(profile: ChannelProfile): SenderLabel | null {
  const { handle, name } = profile;
  if (handle && name) return { stored: handle, customerName: `${name} (@${handle})` };
  if (handle) return { stored: handle, customerName: `@${handle}` };
  if (name) return { stored: name, customerName: name };
  return null;
}
