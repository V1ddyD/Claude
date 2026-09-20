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

export interface ChannelProvider {
  readonly name: string;
  send(message: OutgoingChannelMessage): Promise<ChannelSendResult>;
}

/** Pinned rather than floating: a version bump is a decision, not a surprise. */
const GRAPH_VERSION = 'v21.0';

/**
 * Instagram and Messenger both send through the Messenger Platform's Send API,
 * addressed to the business account's own id. WhatsApp uses a different shape
 * and is deliberately not implemented here — claiming support for a channel we
 * have not tested is worse than not offering it.
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
        `https://graph.facebook.com/${GRAPH_VERSION}/${message.senderExternalId}/messages`,
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
