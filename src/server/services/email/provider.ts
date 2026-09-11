import 'server-only';
import { env, features } from '@/server/config/env';

/**
 * The email provider, behind an interface.
 *
 * The outbox does not depend on Resend: the provider is swappable, and tests
 * substitute a recorder. What matters to the rest of the system is the contract
 * below — a send either returns a provider id (accepted) or an error, and
 * "accepted" is the only thing that lets a message leave `queued`.
 */

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  from: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult =
  | { accepted: true; providerMessageId: string }
  | { accepted: false; error: string; retryable: boolean };

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

class ResendProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(private readonly apiKey: string) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${email.fromName} <${email.from}>`,
          to: [email.to],
          reply_to: email.replyTo,
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return {
          accepted: false,
          error: `${response.status} ${detail}`.slice(0, 500),
          // 4xx is our fault and will fail identically on retry; 429 and 5xx
          // are worth another attempt.
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      const body = (await response.json()) as { id?: string };
      if (!body.id) {
        return { accepted: false, error: 'Provider returned no message id', retryable: true };
      }
      return { accepted: true, providerMessageId: body.id };
    } catch (error) {
      // Network failures are transient by default.
      return {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }
}

/**
 * Used when no provider is configured.
 *
 * It refuses rather than pretending: a message stays queued and the customer is
 * never told anything was sent. Silently "succeeding" here is precisely the
 * failure spec §21 exists to prevent.
 */
class UnconfiguredProvider implements EmailProvider {
  readonly name = 'unconfigured';

  async send(): Promise<SendResult> {
    return { accepted: false, error: 'No email provider is configured', retryable: true };
  }
}

let provider: EmailProvider | undefined;

export function emailProvider(): EmailProvider {
  provider ??= features.email ? new ResendProvider(env.RESEND_API_KEY!) : new UnconfiguredProvider();
  return provider;
}

/** Test seam. */
export function setEmailProvider(next: EmailProvider | null): void {
  provider = next ?? undefined;
}
