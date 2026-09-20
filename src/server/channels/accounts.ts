import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { channelAccounts, type MessagingChannel } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';

/**
 * Connecting and disconnecting a dealership's messaging account.
 *
 * This is the whole of what onboarding a channel means: one row saying which
 * platform account belongs to which dealership, and the token that lets us
 * answer as them. Everything else — the webhook, the conversation, the
 * scoring — already works the moment that row exists.
 *
 * Deliberately not a self-serve flow. The first few dealerships are connected
 * by hand, which is slower per customer and far faster overall: the manual
 * work is where you find out what the product should actually do.
 */

export interface ConnectedAccount {
  id: string;
  channel: MessagingChannel;
  externalAccountId: string;
  displayName: string | null;
  isActive: boolean;
  /** Whether a token is held. Never the token itself. */
  hasToken: boolean;
  tokenExpiresAt: Date | null;
}

export async function connectChannelAccount(params: {
  tenantId: string;
  channel: MessagingChannel;
  externalAccountId: string;
  accessToken: string;
  displayName?: string | null;
  /** Instagram's long-lived token lasts 60 days; Meta tells us how long. */
  expiresInSeconds?: number;
}): Promise<ConnectedAccount> {
  const tokenExpiresAt = params.expiresInSeconds
    ? new Date(Date.now() + params.expiresInSeconds * 1000)
    : null;

  return withTenant(params.tenantId, async (db) => {
    const rows = await db
      .insert(channelAccounts)
      .values({
        tenantId: db.tenantId,
        channel: params.channel,
        externalAccountId: params.externalAccountId,
        accessToken: params.accessToken,
        displayName: params.displayName ?? null,
        tokenExpiresAt,
        isActive: true,
      })
      // Reconnecting is the common case — a token expires every 60 days, and
      // the dealership pastes a new one. That must update the account rather
      // than fail, or the only way to refresh a token is to delete a row.
      .onConflictDoUpdate({
        target: [channelAccounts.channel, channelAccounts.externalAccountId],
        set: {
          accessToken: params.accessToken,
          displayName: params.displayName ?? null,
          tokenExpiresAt,
          isActive: true,
          updatedAt: sql`now()`,
        },
        // Scoped to the caller's own tenant: without this, the unique key is
        // global, so connecting an account another dealership already holds
        // would silently hand them ours.
        setWhere: eq(channelAccounts.tenantId, params.tenantId),
      })
      .returning({
        id: channelAccounts.id,
        channel: channelAccounts.channel,
        externalAccountId: channelAccounts.externalAccountId,
        displayName: channelAccounts.displayName,
        isActive: channelAccounts.isActive,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
      });

    const row = rows[0];
    // No row back means the conflict target matched a row belonging to
    // somebody else. Said plainly rather than reported as a success that
    // changed nothing.
    if (!row) {
      throw new Error(
        `${params.channel} account ${params.externalAccountId} is connected to another tenant`,
      );
    }

    return { ...row, hasToken: true };
  });
}

/** What a dealership has connected. Never includes a token. */
export async function listChannelAccounts(tenantId: string): Promise<ConnectedAccount[]> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .select({
        id: channelAccounts.id,
        channel: channelAccounts.channel,
        externalAccountId: channelAccounts.externalAccountId,
        displayName: channelAccounts.displayName,
        isActive: channelAccounts.isActive,
        accessToken: channelAccounts.accessToken,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.tenantId, db.tenantId));

    return rows.map(({ accessToken, ...rest }) => ({
      ...rest,
      hasToken: Boolean(accessToken),
    }));
  });
}

/**
 * Stop answering as an account.
 *
 * Deactivated rather than deleted: the conversations it carried are still the
 * dealership's, and a row that vanishes takes the explanation with it.
 */
export async function disconnectChannelAccount(
  tenantId: string,
  channel: MessagingChannel,
  externalAccountId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .update(channelAccounts)
      .set({ isActive: false, accessToken: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(channelAccounts.tenantId, db.tenantId),
          eq(channelAccounts.channel, channel),
          eq(channelAccounts.externalAccountId, externalAccountId),
        ),
      )
      .returning({ id: channelAccounts.id });

    return rows.length > 0;
  });
}
