import 'server-only';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { withTenant, withoutTenantScope } from '@/server/db/tenant-db';
import { listActiveTenantIds } from '@/server/db/control-plane';
import { channelAccounts, channelInboundMessages, channelMessages } from '@/server/db/schema';

/**
 * Is the messaging path working, and if not, which half is broken?
 *
 * Two questions separate every failure there has been so far:
 *
 *   is the platform delivering?   the inbound ledger records every message id
 *                                 a webhook brought, before any processing
 *   are replies getting out?      the outbox records what was sent, whether
 *                                 the platform accepted it, and its error
 *
 * Operational facts only. No message bodies, no customer ids, no tokens: an
 * error from the platform is kept, with anything that looks like a credential
 * taken out of it.
 */

export interface ChannelDiagnostics {
  checkedAt: string;
  inbound: { last: string | null; last24h: number };
  accounts: AccountDiagnostics[];
}

interface AccountDiagnostics {
  tenant: string;
  channel: string;
  displayName: string | null;
  active: boolean;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  outbound24h: Record<string, number>;
  recent: { at: string; status: string; attempts: number; error: string | null }[];
  /** What Instagram itself says about this account, asked with its own token. */
  platform?: PlatformLink;
}

interface PlatformLink {
  /** The token works: Instagram says who it belongs to. */
  tokenValid: boolean;
  username: string | null;
  /**
   * The webhook subscription: which events Instagram forwards to us. Without
   * "messages" here, DMs arrive in the inbox and never reach the assistant.
   */
  subscribedFields: string[] | null;
  error: string | null;
}

export async function channelDiagnostics(
  options: { askPlatform?: boolean } = {},
): Promise<ChannelDiagnostics> {
  const askPlatform = options.askPlatform ?? true;
  const since = new Date(Date.now() - 24 * 3600_000);

  const inbound = await withoutTenantScope('health', async (db) => {
    const [row] = await db
      .select({
        last: sql<Date | null>`max(${channelInboundMessages.receivedAt})`,
        count: sql<number>`count(*) filter (where ${channelInboundMessages.receivedAt} >= ${since.toISOString()}::timestamptz)::int`,
      })
      .from(channelInboundMessages);
    return row;
  });

  const accounts: AccountDiagnostics[] = [];
  for (const tenantId of await listActiveTenantIds()) {
    const rows = await withTenant(tenantId, async (db) => {
      const connected = await db
        .select({
          id: channelAccounts.id,
          channel: channelAccounts.channel,
          displayName: channelAccounts.displayName,
          active: channelAccounts.isActive,
          hasToken: sql<boolean>`${channelAccounts.accessToken} IS NOT NULL AND length(${channelAccounts.accessToken}) > 0`,
          // Used to ask Instagram about the link below. Never returned.
          accessToken: channelAccounts.accessToken,
          tokenExpiresAt: channelAccounts.tokenExpiresAt,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.tenantId, db.tenantId))
        .limit(10);

      return Promise.all(
        connected.map(async (account) => {
          const counts = await db
            .select({ status: channelMessages.status, n: sql<number>`count(*)::int` })
            .from(channelMessages)
            .where(
              and(
                eq(channelMessages.tenantId, db.tenantId),
                eq(channelMessages.channelAccountId, account.id),
                gte(channelMessages.createdAt, since),
              ),
            )
            .groupBy(channelMessages.status)
            .limit(10);
          const recent = await db
            .select({
              at: channelMessages.createdAt,
              status: channelMessages.status,
              attempts: channelMessages.attempts,
              error: channelMessages.lastError,
            })
            .from(channelMessages)
            .where(
              and(eq(channelMessages.tenantId, db.tenantId), eq(channelMessages.channelAccountId, account.id)),
            )
            .orderBy(desc(channelMessages.createdAt))
            .limit(8);
          return { account, counts, recent };
        }),
      );
    });

    for (const { account, counts, recent } of rows) {
      accounts.push({
        tenant: tenantId,
        channel: account.channel,
        displayName: account.displayName,
        active: account.active,
        hasToken: Boolean(account.hasToken),
        tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
        outbound24h: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        recent: recent.map((r) => ({
          at: r.at.toISOString(),
          status: r.status,
          attempts: r.attempts,
          error: scrub(r.error),
        })),
        platform:
          askPlatform && account.channel === 'instagram' && account.accessToken
            ? await instagramLink(account.accessToken)
            : undefined,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    inbound: {
      last: inbound?.last ? new Date(inbound.last).toISOString() : null,
      last24h: Number(inbound?.count ?? 0),
    },
    accounts,
  };
}

/** A platform error, with anything that could be a credential removed. */
export function scrub(error: string | null): string | null {
  if (!error) return null;
  return error
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]')
    .replace(/[A-Za-z0-9_\-]{40,}/g, '[redacted]')
    .slice(0, 300);
}

const INSTAGRAM = 'https://graph.instagram.com/v26.0';

async function graph(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await fetch(`${INSTAGRAM}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, body };
  } catch (error) {
    return { ok: false, body: { error: { message: error instanceof Error ? error.message : 'request failed' } } };
  }
}

function graphError(body: Record<string, unknown>): string | null {
  const error = body.error as { message?: string; code?: number } | undefined;
  return error ? scrub(`${error.code ?? ''} ${error.message ?? ''}`.trim()) : null;
}

/** Instagram's own answer: does the token work, and is the webhook subscribed? */
async function instagramLink(token: string): Promise<PlatformLink> {
  const me = await graph('/me?fields=user_id,username', token);
  if (!me.ok) {
    return { tokenValid: false, username: null, subscribedFields: null, error: graphError(me.body) };
  }
  const subscribed = await graph('/me/subscribed_apps', token);
  const rows = (subscribed.body.data as { subscribed_fields?: string[] }[] | undefined) ?? [];
  return {
    tokenValid: true,
    username: typeof me.body.username === 'string' ? me.body.username : null,
    subscribedFields: subscribed.ok ? rows.flatMap((row) => row.subscribed_fields ?? []) : null,
    error: subscribed.ok ? null : graphError(subscribed.body),
  };
}

/**
 * Ask Instagram to forward DMs to us again, for every connected account.
 *
 * The one repair this view offers, because it is the one that is both common
 * and harmless: subscribing an account that is already subscribed changes
 * nothing.
 */
export async function resubscribeInstagram(): Promise<{ username: string | null; ok: boolean; error: string | null }[]> {
  const results: { username: string | null; ok: boolean; error: string | null }[] = [];
  for (const tenantId of await listActiveTenantIds()) {
    const tokens = await withTenant(tenantId, (db) =>
      db
        .select({ token: channelAccounts.accessToken })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, db.tenantId),
            eq(channelAccounts.channel, 'instagram'),
            eq(channelAccounts.isActive, true),
          ),
        )
        .limit(10),
    );
    for (const { token } of tokens) {
      if (!token) continue;
      const done = await graph('/me/subscribed_apps?subscribed_fields=messages', token, { method: 'POST' });
      const me = await graph('/me?fields=username', token);
      results.push({
        username: typeof me.body.username === 'string' ? me.body.username : null,
        ok: done.ok && done.body.success !== false,
        error: done.ok ? null : graphError(done.body),
      });
    }
  }
  return results;
}
