import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { channelIdentities, type MessagingChannel } from '@/server/db/schema';
import { withoutTenantScope, type TenantDb } from '@/server/db/tenant-db';
import { ensureVisitor } from '@/server/services/visitors';

/**
 * Working out who an inbound message is from, and who it is for.
 *
 * Two questions the web never had to ask. On the site the tenant comes from
 * the hostname and the person from a signed cookie; a webhook arrives with
 * neither, carrying only two opaque platform ids.
 */

export interface ResolvedChannelAccount {
  channelAccountId: string;
  tenantId: string;
}

/**
 * Which dealership owns the account this message was sent TO.
 *
 * Reads `v_channel_account_lookup`, not the table: resolution must happen
 * before a tenant context exists, and the view carries no access token, so an
 * unscoped read here discloses nothing a sender does not already know.
 *
 * Returns null for an unknown or deactivated account. That is a webhook for
 * something we do not serve, which is a 200-and-ignore, never a guess at which
 * dealership was probably meant.
 */
export async function resolveChannelAccount(
  channel: MessagingChannel,
  externalAccountId: string,
): Promise<ResolvedChannelAccount | null> {
  const rows = await withoutTenantScope('tenant-resolution', (db) =>
    db.execute(sql`
      SELECT id, tenant_id AS "tenantId"
      FROM v_channel_account_lookup
      WHERE channel = ${channel}
        AND external_account_id = ${externalAccountId}
        AND is_active
      LIMIT 1
    `),
  ) as unknown as Array<{ id: string; tenantId: string }>;

  const row = rows[0];
  return row ? { channelAccountId: row.id, tenantId: row.tenantId } : null;
}

export interface ResolvedChannelIdentity {
  visitorId: string;
  customerId: string | null;
}

/**
 * Who is writing.
 *
 * A platform sender id is scoped to the receiving account and is neither an
 * email address nor a phone number, so it cannot identify a CUSTOMER. It
 * identifies a visitor — precisely what a browser cookie does — and the person
 * becomes a customer only when they volunteer their details to a tool, exactly
 * as they would on the website.
 *
 * Idempotent: a returning sender keeps the visitor they had, so their second
 * conversation is attached to the same person rather than to a stranger who
 * happens to write in the same way.
 */
export async function resolveChannelIdentity(
  db: TenantDb,
  params: {
    channel: MessagingChannel;
    externalUserId: string;
    displayName?: string | null;
  },
): Promise<ResolvedChannelIdentity> {
  const existing = await db
    .select({
      id: channelIdentities.id,
      visitorId: channelIdentities.visitorId,
      customerId: channelIdentities.customerId,
    })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.tenantId, db.tenantId),
        eq(channelIdentities.channel, params.channel),
        eq(channelIdentities.externalUserId, params.externalUserId),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found?.visitorId) {
    await db
      .update(channelIdentities)
      .set({
        lastSeenAt: sql`now()`,
        ...(params.displayName ? { displayName: params.displayName } : {}),
      })
      .where(
        and(eq(channelIdentities.tenantId, db.tenantId), eq(channelIdentities.id, found.id)),
      );
    return { visitorId: found.visitorId, customerId: found.customerId };
  }

  const visitorId = await ensureVisitor(db, found?.visitorId ?? null);

  // Upsert rather than insert: two messages arriving together would otherwise
  // race on the unique key, and the loser would 500 on a message the customer
  // did send.
  await db
    .insert(channelIdentities)
    .values({
      tenantId: db.tenantId,
      channel: params.channel,
      externalUserId: params.externalUserId,
      visitorId,
      displayName: params.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: [
        channelIdentities.tenantId,
        channelIdentities.channel,
        channelIdentities.externalUserId,
      ],
      set: { lastSeenAt: sql`now()` },
    });

  return { visitorId, customerId: found?.customerId ?? null };
}

/**
 * Claim an inbound message id, returning false if it has been seen before.
 *
 * Meta redelivers any webhook it did not get a prompt 200 from, and a
 * redelivery is indistinguishable from a new message except by its id. Without
 * this, one slow reply becomes two replies — and, worse, two turns of
 * conversation the customer never sent.
 *
 * Unscoped because it runs before the tenant is known and the ledger holds
 * nothing but a platform id and a timestamp.
 */
export async function claimInboundMessage(
  channel: MessagingChannel,
  externalMessageId: string,
): Promise<boolean> {
  const rows = await withoutTenantScope('tenant-resolution', (db) =>
    db.execute(sql`
      INSERT INTO channel_inbound_messages (channel, external_message_id)
      VALUES (${channel}, ${externalMessageId})
      ON CONFLICT (channel, external_message_id) DO NOTHING
      RETURNING external_message_id
    `),
  ) as unknown as Array<{ external_message_id: string }>;

  return rows.length > 0;
}
