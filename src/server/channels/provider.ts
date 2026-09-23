import 'server-only';
import type { MessagingChannel } from '@/server/db/schema';

/**
 * Sending a message on a messaging channel, behind an interface.
 *
 * The same shape as the email provider, for the same reasons: the outbox does
 * not depend on Meta, a send either returns a provider id or an error, and
 * "accepted" is the only thing that lets a message leave `queued`. Nothing in
 * the system may report a reply as delivered before the platform said so.
 */

export interface OutgoingChannelMessage {
  channel: MessagingChannel;
  /** The platform-scoped id of the person receiving it. */
  recipientExternalId: string;
  /** The business account it is sent AS. */
  senderExternalId: string;
  accessToken: string;
  body: string;
}

export type ChannelSendResult =
  | { accepted: true; providerMessageId: string }
  | { accepted: false; error: string; retryable: boolean };

/** Who a sender is, as far as the platform will say. */
export interface ChannelProfile {
  /** The @handle, without the @. Instagram only. */
  handle?: string;
  /** The name on the profile, if they have set one. */
  name?: string;
}

export interface ChannelProvider {
  readonly name: string;
  send(message: OutgoingChannelMessage): Promise<ChannelSendResult>;
  /**
   * Look up the person behind a platform id.
   *
   * Optional, and best-effort by contract: a profile is a convenience for the
   * salesperson reading the portal, never a precondition for answering the
   * customer. Implementations return null rather than throwing.
   */
  fetchProfile?(params: {
    channel: MessagingChannel;
    externalUserId: string;
    accessToken: string;
  }): Promise<ChannelProfile | null>;
}

/** Pinned rather than floating: a version bump is a decision, not a surprise. */
const GRAPH_VERSION = 'v26.0';

/**
 * Where a reply is posted, by channel.
 *
 * Not cosmetic. An account connected through Instagram Login holds an
 * Instagram user token, and `graph.facebook.com` cannot read one — it answers
 * "Cannot parse access token", which reads like an expired credential and is
 * really a wrong doorway. Messenger keeps the Facebook host, because a Page
 * token genuinely is a Facebook token.
 *
 * Learned the hard way: everything else worked — the message arrived, the
 * assistant answered it — and the reply failed on the last call out.
 */
const SEND_HOST: Record<MessagingChannel, string> = {
  instagram: 'https://graph.instagram.com',
  messenger: 'https://graph.facebook.com',
  whatsapp: 'https://graph.facebook.com',
};

/**
 * Instagram and Messenger use the same Send API shape, addressed to the
 * business account's own id, and differ only in host. WhatsApp uses a
 * different shape and is deliberately not implemented — claiming support for a
 * channel we have not tested is worse than not offering it.
 */
class MetaChannelProvider implements ChannelProvider {
  readonly name = 'meta';

  async send(message: OutgoingChannelMessage): Promise<ChannelSendResult> {
    if (message.channel === 'whatsapp') {
      return {
        accepted: false,
        error: 'WhatsApp sending is not implemented',
        retryable: false,
      };
    }

    try {
      const response = await fetch(
        `${SEND_HOST[message.channel]}/${GRAPH_VERSION}/${message.senderExternalId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${message.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: message.recipientExternalId },
            message: { text: message.body },
          }),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return {
          accepted: false,
          error: `${response.status} ${detail}`.slice(0, 500),
          retryable: isRetryable(response.status, detail),
        };
      }

      const body = (await response.json()) as { message_id?: string };
      if (!body.message_id) {
        return { accepted: false, error: 'Platform returned no message id', retryable: true };
      }
      return { accepted: true, providerMessageId: body.message_id };
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  /**
   * The sender's handle and name, from the platform's user profile endpoint.
   *
   * Needed because the messaging webhook carries a numeric id and nothing
   * else: without this, every DM lead reached the portal as "Unnamed customer"
   * and a salesperson had no way to find the thread in Instagram.
   *
   * Short timeout, and null on any failure. It runs before the customer is
   * answered, so a slow profile lookup is a slow reply, and a failed one must
   * cost nothing but the name.
   */
  async fetchProfile(params: {
    channel: MessagingChannel;
    externalUserId: string;
    accessToken: string;
  }): Promise<ChannelProfile | null> {
    if (params.channel === 'whatsapp') return null;

    const fields = params.channel === 'instagram' ? 'username,name' : 'first_name,last_name,name';

    try {
      const response = await fetch(
        `${SEND_HOST[params.channel]}/${GRAPH_VERSION}/${encodeURIComponent(params.externalUserId)}?fields=${fields}`,
        {
          headers: { Authorization: `Bearer ${params.accessToken}` },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok) return null;

      const body = (await response.json()) as {
        username?: unknown;
        name?: unknown;
        first_name?: unknown;
        last_name?: unknown;
      };

      const handle = cleanProfileText(body.username);
      const name =
        cleanProfileText(body.name) ??
        cleanProfileText([body.first_name, body.last_name].filter((part) => typeof part === 'string').join(' '));

      return handle || name ? { ...(handle ? { handle } : {}), ...(name ? { name } : {}) } : null;
    } catch {
      return null;
    }
  }
}

/**
 * Profile text is whatever the account holder typed, so it is treated as
 * untrusted: control characters removed, whitespace collapsed, length capped.
 * React escapes it on the way to the portal; this keeps it sane on the way in.
 */
function cleanProfileText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || undefined;
}

/**
 * Which failures are worth trying again.
 *
 * The one that matters is error 10 / subcode 2534022: the 24-hour window has
 * closed. Retrying that cannot succeed — the window only reopens when the
 * customer writes again, and by then this reply is answering a question they
 * asked yesterday. It is a permanent failure for this message, and the outbox
 * marks it `expired` so staff can see the thread went cold rather than
 * believing a reply went out.
 */
function isRetryable(status: number, detail: string): boolean {
  if (detail.includes('2534022') || detail.includes('2018278')) return false;
  return status === 429 || status >= 500;
}

/** True when a failure was the messaging window closing rather than an outage. */
export function isWindowClosed(error: string): boolean {
  return error.includes('2534022') || error.includes('2018278');
}

/**
 * Used when nothing is configured.
 *
 * Refuses rather than pretending, exactly as the email provider does: the
 * message stays queued and no one is told a reply was sent.
 */
class UnconfiguredChannelProvider implements ChannelProvider {
  readonly name = 'unconfigured';

  async send(): Promise<ChannelSendResult> {
    return { accepted: false, error: 'No messaging provider is configured', retryable: true };
  }
}

let provider: ChannelProvider | undefined;

export function channelProvider(): ChannelProvider {
  provider ??= new MetaChannelProvider();
  return provider;
}

/** Test seam. */
export function setChannelProvider(next: ChannelProvider | null): void {
  provider = next ?? new UnconfiguredChannelProvider();
}

/** Restores the real provider after a test has replaced it. */
export function resetChannelProvider(): void {
  provider = undefined;
}
