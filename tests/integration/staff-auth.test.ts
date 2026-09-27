import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { ROLE_PERMISSIONS, type Permission } from '../../src/server/auth/permissions';
import type { StaffContext } from '../../src/server/auth/require-staff';
import type { StaffRole } from '../../src/server/db/schema';
import {
  signIn, sessionSubject, endSession, setTemporaryPassword, changeOwnPassword,
} from '../../src/server/auth/staff-auth';
import { passwordProblem, temporaryPassword } from '../../src/server/auth/passwords';
import {
  addMember, removeMember, resetMemberPassword, changeMemberRole, loadTeam,
} from '../../src/server/services/team';

/**
 * Staff sign-in and team management, attacked the way somebody would attack
 * it: forged sessions, guessed passwords, one business reaching into
 * another's staff, and staff reaching past their role.
 */

let admin: Sql;
const RUN = randomUUID().slice(0, 8);

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

/** A fresh business on a given plan, with an owner whose password we know. */
async function business(plan: 'starter' | 'pro' | 'elite' = 'starter') {
  const tenantId = randomUUID();
  const slug = `t-${RUN}-${tenantId.slice(0, 6)}`;
  await admin`
    INSERT INTO tenants (id, slug, legal_name, brand_name, ticket_prefix, plan, timezone, currency, locale)
    VALUES (${tenantId}, ${slug}, ${slug}, ${slug}, 'TST', ${plan}, 'Asia/Brunei', 'BND', 'en-GB')`;
  const owner = await person(tenantId, 'admin', 'Owner Person');
  return { tenantId, owner };
}

async function person(tenantId: string, role: StaffRole, fullName: string, password = `Correct-horse-${RUN}`) {
  const id = randomUUID();
  const email = `${role}.${id.slice(0, 8)}@example.test`;
  await admin`
    INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
    VALUES (${id}, ${tenantId}, ${email}, ${fullName}, ${role}, 'active')`;
  await withTenant(tenantId, (db) => setTemporaryPassword(db, id, email, password));
  // Marked as chosen by them, as a real account would be after first sign-in.
  await admin`UPDATE staff_credentials SET must_change_password = false WHERE staff_id = ${id}`;
  return { id, email, password, role, fullName, tenantId };
}

function actor(p: { id: string; tenantId: string; role: StaffRole; fullName: string; email: string }): StaffContext {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[p.role]);
  return {
    authUserId: p.id, tenantId: p.tenantId, role: p.role, fullName: p.fullName, email: p.email,
    can: (x) => granted.has(x),
    assert: (x) => { if (!granted.has(x)) throw new Error(`missing ${x}`); },
  };
}

async function signedIn(email: string, password: string) {
  // A different address each time: the per-address limit (30 in 15 minutes)
  // would otherwise start refusing the suite's own sign-ins, as it should.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const result = await signIn({ email, password, ip });
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return result.token;
}

describe('signing in', () => {
  it('works with the right password and gives a session tied to that person', async () => {
    const { owner, tenantId } = await business();
    const token = await signedIn(owner.email, owner.password);
    const subject = await sessionSubject(token);
    expect(subject).toMatchObject({ authUserId: owner.id, tenantId, email: owner.email });
  });

  it('says the same thing for a wrong password and an unknown email', async () => {
    const { owner } = await business();
    const wrong = await signIn({ email: owner.email, password: 'not-the-password', ip: '10.0.0.2' });
    const unknown = await signIn({ email: `nobody-${RUN}@example.test`, password: 'whatever12', ip: '10.0.0.3' });
    expect(wrong).toEqual({ ok: false, reason: 'invalid' });
    expect(unknown).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never stores the password or the session token', async () => {
    const { owner } = await business();
    const token = await signedIn(owner.email, owner.password);
    const [credential] = await admin<{ password_hash: string }[]>`
      SELECT password_hash FROM staff_credentials WHERE staff_id = ${owner.id}`;
    expect(credential!.password_hash).toMatch(/^scrypt\$/);
    expect(credential!.password_hash).not.toContain(owner.password);
    const sessions = await admin<{ token_hash: string }[]>`
      SELECT token_hash FROM staff_sessions WHERE staff_id = ${owner.id}`;
    expect(sessions.map((s) => s.token_hash)).not.toContain(token);
  });

  it('refuses a forged or made-up session', async () => {
    const { owner } = await business();
    expect(await sessionSubject(undefined)).toBeNull();
    expect(await sessionSubject(`${owner.id}|${owner.email}`)).toBeNull();
    expect(await sessionSubject('A'.repeat(43))).toBeNull();
  });

  it('stops password guessing, even when the right password comes after', async () => {
    const { owner } = await business();
    for (let i = 0; i < 5; i++) {
      expect((await signIn({ email: owner.email, password: `guess-${i}-xx`, ip: `10.9.${i}.1` })).ok).toBe(false);
    }
    const afterGuessing = await signIn({ email: owner.email, password: owner.password, ip: '10.9.9.9' });
    expect(afterGuessing).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('ends a session on sign out', async () => {
    const { owner } = await business();
    const token = await signedIn(owner.email, owner.password);
    await endSession(token);
    expect(await sessionSubject(token)).toBeNull();
  });

  it('finds the right business when one email works at two', async () => {
    const first = await business();
    const second = await business();
    const email = `shared-${RUN}@example.test`;
    for (const [b, password] of [[first, 'first-business-pw'], [second, 'second-business-pw']] as const) {
      const id = randomUUID();
      await admin`INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
                  VALUES (${id}, ${b.tenantId}, ${email}, 'Shared', 'sales', 'active')`;
      await withTenant(b.tenantId, (db) => setTemporaryPassword(db, id, email, password));
    }
    const token = await signedIn(email, 'second-business-pw');
    expect((await sessionSubject(token))?.tenantId).toBe(second.tenantId);
  });
});

describe('passwords', () => {
  it('refuses weak ones', () => {
    expect(passwordProblem('short', 'a@b.test')).toBe('too_short');
    expect(passwordProblem('password123', 'a@b.test')).toBe('too_common');
    expect(passwordProblem('aaaaaaaaaaaa', 'a@b.test')).toBe('too_simple');
    expect(passwordProblem('hjahmad-2026!', 'hjahmad@b.test')).toBe('contains_email');
    expect(passwordProblem('blue kettle sunrise', 'a@b.test')).toBeNull();
  });

  it('makes temporary ones that are long and random', () => {
    const a = temporaryPassword();
    expect(a).toMatch(/^[A-Za-z2-9]{7}-[A-Za-z2-9]{7}$/);
    expect(temporaryPassword()).not.toBe(a);
  });

  it('needs the current password to change it, and signs out every other device', async () => {
    const { owner, tenantId } = await business();
    const here = await signedIn(owner.email, owner.password);
    const elsewhere = await signedIn(owner.email, owner.password);

    const wrong = await withTenant(tenantId, (db) =>
      changeOwnPassword(db, { authUserId: owner.id, email: owner.email }, {
        current: 'not it', next: 'river lantern orchard', confirm: 'river lantern orchard', keepToken: here,
      }),
    );
    expect(wrong).toEqual({ ok: false, problem: 'wrong_current' });

    const done = await withTenant(tenantId, (db) =>
      changeOwnPassword(db, { authUserId: owner.id, email: owner.email }, {
        current: owner.password, next: 'river lantern orchard', confirm: 'river lantern orchard', keepToken: here,
      }),
    );
    expect(done).toEqual({ ok: true });
    expect(await sessionSubject(here)).not.toBeNull();
    expect(await sessionSubject(elsewhere)).toBeNull();
    expect((await signIn({ email: owner.email, password: 'river lantern orchard', ip: '10.1.1.1' })).ok).toBe(true);
  });
});

describe('managing a team', () => {
  it('lets the owner add staff up to the package limit, then says so', async () => {
    const { owner, tenantId } = await business('starter');
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await withTenant(tenantId, (db) =>
          addMember(db, actor(owner), { fullName: `Staff ${i}`, email: `s${i}-${tenantId.slice(0, 6)}@example.test`, role: 'sales' }),
        ),
      );
    }
    // Starter is 3 accounts including the owner: two more fit, the third does not.
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]).toMatchObject({ ok: false });
    expect(results[2]!.message).toMatch(/Starter package includes 3/);
  });

  it('gives a new member a temporary password they must replace', async () => {
    const { owner, tenantId } = await business('pro');
    const email = `new-${tenantId.slice(0, 6)}@example.test`;
    const added = await withTenant(tenantId, (db) =>
      addMember(db, actor(owner), { fullName: 'New Person', email, role: 'sales' }),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const result = await signIn({ email, password: added.temporaryPassword!, ip: '10.2.2.2' });
    expect(result).toMatchObject({ ok: true, mustChangePassword: true });
  });

  it('signs a removed member out everywhere and stops them signing in', async () => {
    const { owner, tenantId } = await business('pro');
    const member = await person(tenantId, 'sales', 'Leaving Soon');
    const token = await signedIn(member.email, member.password);

    const removed = await withTenant(tenantId, (db) => removeMember(db, actor(owner), member.id));
    expect(removed.ok).toBe(true);
    expect(await sessionSubject(token)).toBeNull();
    expect((await signIn({ email: member.email, password: member.password, ip: '10.3.3.3' })).ok).toBe(false);
  });

  it('signs a member out everywhere when the owner resets their password', async () => {
    const { owner, tenantId } = await business('pro');
    const member = await person(tenantId, 'sales', 'Forgetful');
    const token = await signedIn(member.email, member.password);
    const reset = await withTenant(tenantId, (db) => resetMemberPassword(db, actor(owner), member.id));
    expect(reset.ok).toBe(true);
    expect(await sessionSubject(token)).toBeNull();
    expect((await signIn({ email: member.email, password: member.password, ip: '10.4.4.4' })).ok).toBe(false);
  });

  it('never lets one business touch another business’s staff', async () => {
    const mine = await business('elite');
    const theirs = await business('elite');
    const victim = await person(theirs.tenantId, 'sales', 'Someone Else');
    for (const attempt of [
      () => withTenant(mine.tenantId, (db) => removeMember(db, actor(mine.owner), victim.id)),
      () => withTenant(mine.tenantId, (db) => resetMemberPassword(db, actor(mine.owner), victim.id)),
      () => withTenant(mine.tenantId, (db) => changeMemberRole(db, actor(mine.owner), victim.id, 'admin')),
    ]) {
      expect(await attempt()).toMatchObject({ ok: false });
    }
    const team = await withTenant(mine.tenantId, (db) => loadTeam(db, actor(mine.owner)));
    expect(team.members.map((m) => m.id)).not.toContain(victim.id);
  });

  it('keeps managers within their role', async () => {
    const { owner, tenantId } = await business('elite');
    const manager = await person(tenantId, 'manager', 'Middle Manager');
    const asManager = actor(manager);
    const added = await withTenant(tenantId, (db) =>
      addMember(db, asManager, { fullName: 'Would Be Owner', email: `wbo-${tenantId.slice(0, 6)}@example.test`, role: 'admin' }),
    );
    expect(added.ok).toBe(false);
    expect((await withTenant(tenantId, (db) => removeMember(db, asManager, owner.id))).ok).toBe(false);
    expect((await withTenant(tenantId, (db) => resetMemberPassword(db, asManager, owner.id))).ok).toBe(false);
  });

  it('never leaves a business without an owner, and nobody removes themselves', async () => {
    const { owner, tenantId } = await business('elite');
    const second = await person(tenantId, 'admin', 'Second Owner');
    expect((await withTenant(tenantId, (db) => removeMember(db, actor(owner), owner.id))).ok).toBe(false);
    // Removing the other owner is fine while one remains...
    expect((await withTenant(tenantId, (db) => removeMember(db, actor(owner), second.id))).ok).toBe(true);
    // ...and a lone owner cannot be demoted by anyone.
    const third = await person(tenantId, 'admin', 'Third Owner');
    await withTenant(tenantId, (db) => removeMember(db, actor(third), owner.id));
    expect((await withTenant(tenantId, (db) => changeMemberRole(db, actor(owner), third.id, 'sales'))).ok).toBe(false);
  });
});

describe('the database itself', () => {
  it('lets a sign-in see only the email being signed in with, and a session only its own row', async () => {
    const { withSignInLookup } = await import('../../src/server/db/tenant-db');
    const { staffCredentials, staffSessions } = await import('../../src/server/db/schema');
    const a = await business();
    const b = await business();
    await signedIn(b.owner.email, b.owner.password);

    const visible = await withSignInLookup({ email: a.owner.email }, (tx) =>
      tx.select({ email: staffCredentials.email }).from(staffCredentials).limit(1000),
    );
    expect(visible.map((row) => row.email)).toEqual([a.owner.email]);

    const sessions = await withSignInLookup({ tokenHash: 'not-a-real-token-hash' }, (tx) =>
      tx.select({ id: staffSessions.id }).from(staffSessions).limit(1000),
    );
    expect(sessions).toEqual([]);
  });
});

describe('the team list', () => {
  it('shows when each person last signed in', async () => {
    const { owner, tenantId } = await business('pro');
    await signedIn(owner.email, owner.password);
    const team = await withTenant(tenantId, (db) => loadTeam(db, actor(owner)));
    expect(team.members.find((m) => m.id === owner.id)?.lastSignIn).toBeInstanceOf(Date);
  });
});
