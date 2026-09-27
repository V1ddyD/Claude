import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, SINCLAIR_STAFF } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { resolveCustomer, upsertLead } from '../../src/server/services/leads';
import {
  markLeadDone, reopenLead, reopenIfCustomerReturned, markAppointmentDone,
} from '../../src/server/services/leads/done';
import { listLeads, countByPriority } from '../../src/server/db/repositories/leads';
import { listDueFollowUps } from '../../src/server/services/follow-ups';
import { ROLE_PERMISSIONS, type Permission } from '../../src/server/auth/permissions';
import type { StaffContext } from '../../src/server/auth/require-staff';
import type { StaffRole } from '../../src/server/db/schema';

/**
 * "Mark as done": a customer who has been taken care of leaves every to-do
 * list, and comes back by themselves if they write again.
 */

let admin: Sql;

function staffContext(role: StaffRole, id: string, name: string): StaffContext {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role]);
  return {
    authUserId: id, tenantId: SINCLAIR_TENANT_ID, role, fullName: name,
    email: 't@sinclair.test',
    can: (p) => granted.has(p),
    assert: (p) => { if (!granted.has(p)) throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); },
  };
}
const manager = () => staffContext('manager', SINCLAIR_STAFF.manager.id, 'Priya Raman');
const sales = () => staffContext('sales', SINCLAIR_STAFF.sales.id, 'Marcus Hale');

async function newLead(): Promise<{ leadId: string; conversationId: string; customerId: string }> {
  return withTenant(SINCLAIR_TENANT_ID, async (db) => {
    const [conv] = (await db.execute(sql`
      INSERT INTO conversations (tenant_id) VALUES (${SINCLAIR_TENANT_ID}) RETURNING id`)) as unknown as { id: string }[];
    const customerId = (await resolveCustomer(db, {
      fullName: 'Done Test',
      email: `done.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`,
      contactConsent: true,
    }))!;
    const leadId = await upsertLead(db, { conversationId: conv!.id, customerId });
    return { leadId, conversationId: conv!.id, customerId };
  });
}

async function appointment(leadId: string, customerId: string, startsAt: Date): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO appointments (tenant_id, type, customer_id, lead_id, starts_at, ends_at, confirmation_code, created_by_type)
    VALUES (${SINCLAIR_TENANT_ID}, 'test_drive', ${customerId}, ${leadId}, ${startsAt},
            ${new Date(startsAt.getTime() + 3_600_000)}, ${'D' + Math.random().toString(36).slice(2, 8).toUpperCase()}, 'ai')
    RETURNING id`;
  return row!.id;
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('mark as done', () => {
  it('takes the lead off the lists and the counts, and closes its follow-ups', async () => {
    const { leadId } = await newLead();
    await admin`UPDATE leads SET priority = 'high' WHERE id = ${leadId}`;
    await admin`
      INSERT INTO follow_up_tasks (tenant_id, lead_id, rule_key, reason, recommended_action, due_at)
      VALUES (${SINCLAIR_TENANT_ID}, ${leadId}, 'test', 'Test', 'Call them', now() - interval '1 hour')`;

    const before = await withTenant(SINCLAIR_TENANT_ID, async (db) => ({
      active: await listLeads(db, manager(), 500),
      counts: await countByPriority(db, manager()),
      due: await listDueFollowUps(db, SINCLAIR_STAFF.manager.id, true),
    }));
    expect(before.active.map((l) => l.id)).toContain(leadId);
    expect(before.due.map((t) => t.leadId)).toContain(leadId);

    await withTenant(SINCLAIR_TENANT_ID, (db) => markLeadDone(db, sales(), leadId));

    const after = await withTenant(SINCLAIR_TENANT_ID, async (db) => ({
      active: await listLeads(db, manager(), 500),
      done: await listLeads(db, manager(), 500, { done: true }),
      counts: await countByPriority(db, manager()),
      due: await listDueFollowUps(db, SINCLAIR_STAFF.manager.id, true),
    }));
    expect(after.active.map((l) => l.id)).not.toContain(leadId);
    expect(after.done.map((l) => l.id)).toContain(leadId);
    expect(after.counts.high).toBe(before.counts.high - 1);
    expect(after.due.map((t) => t.leadId)).not.toContain(leadId);

    const [task] = await admin<{ status: string }[]>`SELECT status FROM follow_up_tasks WHERE lead_id = ${leadId}`;
    expect(task?.status).toBe('done');
    const [event] = await admin<{ summary: string }[]>`
      SELECT summary FROM lead_events WHERE lead_id = ${leadId} ORDER BY created_at DESC LIMIT 1`;
    expect(event?.summary).toContain('Marcus Hale marked this as done');
  });

  it('finishes appointments that have happened and leaves future ones in the calendar', async () => {
    const { leadId, customerId } = await newLead();
    const past = await appointment(leadId, customerId, new Date(Date.now() - 86_400_000));
    const future = await appointment(leadId, customerId, new Date(Date.now() + 86_400_000));

    await withTenant(SINCLAIR_TENANT_ID, (db) => markLeadDone(db, manager(), leadId));

    const rows = await admin<{ id: string; status: string }[]>`
      SELECT id, status FROM appointments WHERE id IN (${past}, ${future})`;
    expect(rows.find((r) => r.id === past)?.status).toBe('completed');
    expect(rows.find((r) => r.id === future)?.status).toBe('scheduled');
  });

  it('can be reopened', async () => {
    const { leadId } = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) => markLeadDone(db, manager(), leadId));
    await withTenant(SINCLAIR_TENANT_ID, (db) => reopenLead(db, manager(), leadId));

    const active = await withTenant(SINCLAIR_TENANT_ID, (db) => listLeads(db, manager(), 500));
    expect(active.map((l) => l.id)).toContain(leadId);
  });

  it('comes back by itself when the customer writes again, and not before', async () => {
    const { leadId, conversationId } = await newLead();
    await admin`
      INSERT INTO messages (tenant_id, conversation_id, seq, role, content)
      VALUES (${SINCLAIR_TENANT_ID}, ${conversationId}, 1, 'user', 'hello')`;
    await withTenant(SINCLAIR_TENANT_ID, (db) => markLeadDone(db, manager(), leadId));

    // Re-reading the old conversation does not undo the decision.
    expect(await withTenant(SINCLAIR_TENANT_ID, (db) => reopenIfCustomerReturned(db, leadId, conversationId))).toBe(false);

    await admin`
      INSERT INTO messages (tenant_id, conversation_id, seq, role, content, created_at)
      VALUES (${SINCLAIR_TENANT_ID}, ${conversationId}, 2, 'user', 'me again', now() + interval '1 second')`;
    expect(await withTenant(SINCLAIR_TENANT_ID, (db) => reopenIfCustomerReturned(db, leadId, conversationId))).toBe(true);

    const [lead] = await admin<{ done_at: Date | null }[]>`SELECT done_at FROM leads WHERE id = ${leadId}`;
    expect(lead?.done_at).toBeNull();
  });

  it("does not let a salesperson close somebody else's lead", async () => {
    const { leadId } = await newLead();
    await admin`UPDATE leads SET assigned_staff_id = ${SINCLAIR_STAFF.manager.id} WHERE id = ${leadId}`;
    await expect(withTenant(SINCLAIR_TENANT_ID, (db) => markLeadDone(db, sales(), leadId))).rejects.toThrow();
    const [lead] = await admin<{ done_at: Date | null }[]>`SELECT done_at FROM leads WHERE id = ${leadId}`;
    expect(lead?.done_at).toBeNull();
  });
});

describe('appointment done', () => {
  it('takes it off the calendar', async () => {
    const { leadId, customerId } = await newLead();
    const id = await appointment(leadId, customerId, new Date(Date.now() + 3_600_000));
    await withTenant(SINCLAIR_TENANT_ID, (db) => markAppointmentDone(db, sales(), id));
    const [row] = await admin<{ status: string }[]>`SELECT status FROM appointments WHERE id = ${id}`;
    expect(row?.status).toBe('completed');
  });
});
