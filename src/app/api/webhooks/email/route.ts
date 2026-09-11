import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { applyDeliveryEvent } from '@/server/services/email/outbox';
import { env } from '@/server/config/env';

/**
 * Delivery status from the email provider.
 *
 * This is the only route by which a message becomes `delivered` or `bounced`.
 * The signature is verified BEFORE the body is parsed: an unverified webhook is
 * an unauthenticated write to our records.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENT_MAP: Record<string, 'delivered' | 'bounced' | 'complained'> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export async function POST(request: NextRequest) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 });
  }

  const raw = await request.text();
  if (!verify(raw, request.headers.get('svix-signature'), secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  const type = EVENT_MAP[event.type ?? ''];
  const providerMessageId = event.data?.email_id;

  // Unknown event types are acknowledged, not retried: returning an error would
  // make the provider redeliver something we will never handle.
  if (!type || !providerMessageId) {
    return NextResponse.json({ ignored: true });
  }

  const applied = await applyDeliveryEvent({ providerMessageId, type, payload: event });
  return NextResponse.json({ applied });
}

function verify(body: string, header: string | null, secret: string): boolean {
  if (!header) return false;

  const expected = createHmac('sha256', secret).update(body).digest('base64');

  // The header may carry several space-separated signatures during rotation.
  return header.split(' ').some((candidate) => {
    const value = candidate.includes(',') ? candidate.split(',')[1]! : candidate;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
