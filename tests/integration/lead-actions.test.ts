import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, SINCLAIR_STAFF } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { resolveCustomer, upsertLead } from '../../src/server/services/leads';
import { changeStatus, assignLead, addStaffNote, allowedNextStatuses }
  from '../../src/server/services/leads/actions';
import { evaluateFollowUps } from '../../src/server/services/follow-ups';
import { ROLE_PERMISSIONS, type Permission } from '../../src/server/auth/permissions';
import type { StaffContext } from '../../src/server/auth/require-staff';
import type { StaffRole } from '../../src/server/db/schema';
import { isAppError } from '../../src/server/errors';

let admin: Sql;

function staffContext(role: StaffRole, id: string, name = 'Test Staff'): StaffContext {
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

async function newLead(): Promise<string> {
  return withTenant(SINCLAIR_TENANT_ID, async (db) => {
    const [conv] = (await db.execute(
      (await import('drizzle-orm')).sql`
        INSERT INTO conversations (tenant_id) VALUES (${SINCLAIR_TENANT_ID}) RETURNING id`,
    )) as unknown as { id: string }[];
    const customerId = (await resolveCustomer(db, {
      fullName: 'Action Test',
      email: `action.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`,
      contactConsent: true,
    }))!;
    return upsertLead(db, { conversationId: conv!.id, customerId });
  });
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('status', () => {
  it('follows the pipeline and records who moved it', async () => {
    const leadId = await newLead();

    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      changeStatus(db, sales(), { leadId, status: 'contacted' }),
    );

    const [lead] = await admin<{ status: string }[]>`SELECT status FROM leads WHERE id = ${leadId}`;
    expect(lead?.status).toBe('contacted');

    const [event] = await admin<{ summary: string; actor_type: string }[]>`
      SELECT summary, actor_type FROM lead_events
      WHERE lead_id = ${leadId} AND type = 'status_changed' ORDER BY created_at DESC LIMIT 1
    `;
    expect(event?.actor_type).toBe('staff');
    expect(event?.summary).toContain('Marcus Hale');
  });

  it('refuses a jump the pipeline does not allow', async () => {
    const leadId = await newLead();
    try {
      // New straight to Won skips every step that would make it meaningful.
      await withTenant(SINCLAIR_TENANT_ID, (db) =>
        changeStatus(db, manager(), { leadId, status: 'won' }),
      );
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('CONFLICT');
      // The error names what IS allowed, so the UI can offer it.
      expect(err.data?.allowed).toContain('contacted');
    }
  });

  it('treats Won as terminal', () => {
    expect(allowedNextStatuses('won')).toEqual([]);
  });

  it('records a lost reason and clears it if reopened', async () => {
    const leadId = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      changeStatus(db, manager(), { leadId, status: 'lost', lostReason: 'Bought elsewhere' }),
    );

    const [lost] = await admin<{ lost_reason: string; closed_at: Date | null }[]>`
      SELECT lost_reason, closed_at FROM leads WHERE id = ${leadId}
    `;
    expect(lost?.lost_reason).toBe('Bought elsewhere');
    expect(lost?.closed_at).not.toBeNull();

    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      changeStatus(db, manager(), { leadId, status: 'nurture' }),
    );
    const [reopened] = await admin<{ lost_reason: string | null; closed_at: Date | null }[]>`
      SELECT lost_reason, closed_at FROM leads WHERE id = ${leadId}
    `;
    expect(reopened?.lost_reason).toBeNull();
    expect(reopened?.closed_at).toBeNull();
  });

  it("stops a salesperson editing someone else's lead", async () => {
    const leadId = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      assignLead(db, manager(), { leadId, staffId: SINCLAIR_STAFF.salesTwo.id }),
    );

    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        changeStatus(db, sales(), { leadId, status: 'contacted' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('assignment', () => {
  it('is a manager action, not a salesperson one', async () => {
    const leadId = await newLead();
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        assignLead(db, sales(), { leadId, staffId: SINCLAIR_STAFF.sales.id }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('verifies the assignee against the database, not the form', async () => {
    const leadId = await newLead();
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        // A staff id from another dealership: untrusted input.
        assignLead(db, manager(), { leadId, staffId: '607e1a1d-57af-4000-8000-000000000001' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('can unassign, returning the lead to the pool', async () => {
    const leadId = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      assignLead(db, manager(), { leadId, staffId: SINCLAIR_STAFF.sales.id }),
    );
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      assignLead(db, manager(), { leadId, staffId: null }),
    );

    const [lead] = await admin<{ assigned_staff_id: string | null }[]>`
      SELECT assigned_staff_id FROM leads WHERE id = ${leadId}
    `;
    expect(lead?.assigned_staff_id).toBeNull();
  });
});

describe('staff notes', () => {
  it('are stored against the lead and attributed', async () => {
    const leadId = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      addStaffNote(db, sales(), { leadId, body: 'Prefers phone contact after 5pm.' }),
    );

    const [note] = await admin<{ body: string; author_id: string }[]>`
      SELECT body, author_id FROM staff_notes WHERE lead_id = ${leadId}
    `;
    expect(note?.body).toBe('Prefers phone contact after 5pm.');
    expect(note?.author_id).toBe(SINCLAIR_STAFF.sales.id);
  });

  it('never appear in the customer-facing conversation', async () => {
    const leadId = await newLead();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      addStaffNote(db, sales(), { leadId, body: 'Tyre-kicker, low intent.' }),
    );

    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM messages WHERE content ILIKE '%tyre-kicker%'
    `;
    expect(row?.count).toBe(0);
  });

  it('rejects an empty note', async () => {
    const leadId = await newLead();
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) => addStaffNote(db, sales(), { leadId, body: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('follow-ups', () => {
  /**
   * Follow-ups are evaluated over every lead a dealership has, and leads
   * accumulate across runs. Each test below asserts about the lead IT created,
   * so everything already in the database is put beyond the rules' reach first
   * — otherwise the suite passes only until the hundredth stale lead, which is
   * a worse way to find out.
   */
  beforeEach(async () => {
    await admin`
      UPDATE leads SET status = 'lost', last_activity_at = now()
      WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    await admin`DELETE FROM follow_up_tasks WHERE tenant_id = ${SINCLAIR_TENANT_ID}`;
    await admin`UPDATE tickets SET status = 'closed' WHERE tenant_id = ${SINCLAIR_TENANT_ID}`;
    await admin`
      UPDATE appointments SET status = 'completed'
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND starts_at < now()
    `;
  });

  it('raises a task for a high-priority lead nobody has touched', async () => {
    const leadId = await newLead();
    await admin`
      UPDATE leads SET priority = 'high', status = 'new',
        created_at = now() - interval '4 hours' WHERE id = ${leadId}
    `;

    const report = await evaluateFollowUps(SINCLAIR_TENANT_ID);
    expect(report.created).toBeGreaterThan(0);

    const [task] = await admin<{ recommended_action: string; rule_key: string }[]>`
      SELECT recommended_action, rule_key FROM follow_up_tasks WHERE lead_id = ${leadId}
    `;
    expect(task?.rule_key).toBe('high_priority_untouched');
    // Staff are told what to do, not just that something is due.
    expect(task?.recommended_action).toContain('Call');
  });

  it('is idempotent — a second run does not nag twice', async () => {
    const leadId = await newLead();
    await admin`
      UPDATE leads SET priority = 'high', status = 'new',
        created_at = now() - interval '4 hours' WHERE id = ${leadId}
    `;

    await evaluateFollowUps(SINCLAIR_TENANT_ID);
    await evaluateFollowUps(SINCLAIR_TENANT_ID);

    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM follow_up_tasks WHERE lead_id = ${leadId}
    `;
    expect(row?.count).toBe(1);
  });

  it('never messages the customer', async () => {
    const leadId = await newLead();
    await admin`
      UPDATE leads SET priority = 'high', status = 'new',
        created_at = now() - interval '4 hours' WHERE id = ${leadId}
    `;

    const before = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM email_messages`;
    await evaluateFollowUps(SINCLAIR_TENANT_ID);
    const after = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM email_messages`;

    // Spec §14: the system notices and tells staff. It does not chase people.
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it('notifies staff once for a batch rather than once per task', async () => {
    await admin`DELETE FROM notifications WHERE type = 'follow_ups_due'`;
    for (let i = 0; i < 3; i++) {
      const leadId = await newLead();
      await admin`
        UPDATE leads SET priority = 'high', status = 'new',
          created_at = now() - interval '4 hours' WHERE id = ${leadId}
      `;
    }

    await evaluateFollowUps(SINCLAIR_TENANT_ID);

    const notifications = await admin<{ title: string }[]>`
      SELECT title FROM notifications WHERE type = 'follow_ups_due'
    `;
    expect(notifications).toHaveLength(1);
  });
});
