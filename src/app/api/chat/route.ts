import { NextResponse, type NextRequest } from 'next/server';
import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { resolveTenantByHost } from '@/server/context/tenant';
import { ensureConversation } from '@/server/ai/extraction';
import { respondToMessage } from '@/server/ai/conversation';
import { withTenant } from '@/server/db/tenant-db';
import { enqueue } from '@/server/jobs';
import { toPublicError, isAppError, AppError } from '@/server/errors';
import { isProduction } from '@/server/config/env';

/**
 * The customer chat endpoint.
 *
 * Node runtime: it opens database transactions and calls the model. The tenant
 * comes from the hostname and the visitor from a signed cookie — neither is
 * ever accepted from the request body, which is the whole attack.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISITOR_COOKIE = 'sinclair_visitor';

const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
});

/** Per-visitor limit. A public endpoint calling a frontier model is an open cost surface. */
const RATE_LIMIT = { windowMs: 60_000, max: 12 };
const recentRequests = new Map<string, number[]>();

function rateLimited(key: string, now: number): boolean {
  const window = (recentRequests.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  window.push(now);
  recentRequests.set(key, window);
  return window.length > RATE_LIMIT.max;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();

  try {
    const tenant = await resolveTenantByHost((await headers()).get('host'));

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'That message could not be read.');
    }

    const cookieStore = await cookies();
    const existingVisitor = cookieStore.get(VISITOR_COOKIE)?.value;

    const rateKey = existingVisitor ?? request.headers.get('x-forwarded-for') ?? 'anonymous';
    if (rateLimited(`${tenant.id}:${rateKey}`, Date.now())) {
      throw new AppError('RATE_LIMITED', 'You are sending messages very quickly. Please pause a moment.');
    }

    // Creates the visitor if the cookie is missing, unknown, or belongs to
    // another dealership — a cookie value is never trusted as an identity.
    const session = await ensureConversation(tenant.id, {
      conversationId: parsed.data.conversationId,
      visitorId: existingVisitor,
    });

    const reply = await respondToMessage({
      tenantId: tenant.id,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: parsed.data.message,
      requestId,
    });

    // Extraction and scoring run off the customer's critical path. They also
    // run in a context that has never held a customer-facing reply, which is
    // what keeps internal state structurally unable to leak into one.
    await withTenant(tenant.id, (db) =>
      enqueue(db, 'extract_and_score', { conversationId: session.conversationId }),
    );

    const response = NextResponse.json({
      message: reply.text,
      conversationId: session.conversationId,
      degraded: reply.degraded,
      ...(reply.receipt ? { receipt: reply.receipt } : {}),
    });

    if (session.visitorId !== existingVisitor) {
      response.cookies.set(VISITOR_COOKIE, session.visitorId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        path: '/',
        maxAge: 60 * 60 * 24 * 180,
      });
    }

    return response;
  } catch (error) {
    if (!isAppError(error)) {
      console.error(`[chat] ${requestId}`, error);
    }
    const published = toPublicError(error);
    return NextResponse.json(published, {
      status: isAppError(error) ? error.status : 500,
    });
  }
}
