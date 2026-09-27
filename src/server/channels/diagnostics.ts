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
}

export async function channelDiagnostics(): Promise<ChannelDiagnostics> {
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
