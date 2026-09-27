import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { staffCredentials, staffSessions, staffUsers } from '@/server/db/schema';
import { withSignInLookup, type TenantDb } from '@/server/db/tenant-db';
import { checkRateLimit } from '@/server/services/limits';
import { burnTime, hashPassword, passwordProblem, verifyPassword, type PasswordProblem } from './passwords';

/**
 * Staff sign-in, sessions and passwords.
 *
 * The rules, all enforced here rather than trusted to a page:
 *
 *   one answer for every failure   a wrong email and a wrong password read
 *                                  the same and take the same time, so the
 *                                  form cannot be used to find out who works
 *                                  where
 *   guessing is slow               5 tries per email and 30 per address every
 *                                  15 minutes, and 10 wrong passwords in a row
 *                                  lock that account for 15 minutes
 *   sessions live on the server    the cookie is a random token; the database
 *                                  holds its hash. Removing somebody, or
 *                                  resetting their password, ends every one of
 *                                  their sessions at once
 */

export const SESSION_DAYS = 7;
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export type SignInResult =
  | { ok: true; token: string; mustChangePassword: boolean }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 254);
}

export async function signIn(input: { email: string; password: string; ip?: string | null }): Promise<SignInResult> {
  const email = normaliseEmail(input.email);
  const password = input.password.slice(0, 256);
  if (!email.includes('@') || password.length === 0) return { ok: false, reason: 'invalid' };

  const [perEmail, perAddress] = await Promise.all([
    checkRateLimit({ bucket: 'sign-in-email', subject: sha256(email).slice(0, 32), max: 5, windowSeconds: 900 }),
    checkRateLimit({
      bucket: 'sign-in-ip',
      subject: sha256(input.ip ?? 'unknown').slice(0, 32),
      max: 30,
      windowSeconds: 900,
    }),
  ]);
  if (!perEmail.allowed || !perAddress.allowed) return { ok: false, reason: 'rate_limited' };

  return withSignInLookup({ email }, async (tx, enterTenant) => {
    const candidates = await tx
      .select({
        staffId: staffCredentials.staffId,
        tenantId: staffCredentials.tenantId,
        passwordHash: staffCredentials.passwordHash,
        mustChangePassword: staffCredentials.mustChangePassword,
        failedAttempts: staffCredentials.failedAttempts,
        lockedUntil: staffCredentials.lockedUntil,
      })
      .from(staffCredentials)
      .where(eq(staffCredentials.email, email))
      .limit(5);

    if (candidates.length === 0) {
      await burnTime(password);
      return { ok: false, reason: 'invalid' } as const;
    }

    const now = new Date();
    for (const candidate of candidates) {
      // A locked account still costs the same time, and still says only
      // "invalid": telling a guesser it is locked tells them it exists.
      const locked = candidate.lockedUntil !== null && candidate.lockedUntil > now;
      const matches = await verifyPassword(password, candidate.passwordHash);
      if (locked) continue;

      if (!matches) {
        const failures = candidate.failedAttempts + 1;
        await tx
          .update(staffCredentials)
          .set(
            failures >= LOCK_AFTER
              ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
              : { failedAttempts: failures },
          )
          .where(eq(staffCredentials.staffId, candidate.staffId));
        continue;
      }

      await tx
        .update(staffCredentials)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(staffCredentials.staffId, candidate.staffId));

      // Their business, from here on.
      await enterTenant(candidate.tenantId, candidate.staffId);
      const [staff] = await tx
        .select({ status: staffUsers.status })
        .from(staffUsers)
        .where(and(eq(staffUsers.tenantId, candidate.tenantId), eq(staffUsers.id, candidate.staffId)))
        .limit(1);
      if (!staff || staff.status !== 'active') continue;

      const token = randomBytes(32).toString('base64url');
      await tx.insert(staffSessions).values({
        tenantId: candidate.tenantId,
        staffId: candidate.staffId,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
      });
      return { ok: true, token, mustChangePassword: candidate.mustChangePassword } as const;
    }
    return { ok: false, reason: 'invalid' } as const;
  });
}

export interface SessionSubject {
  authUserId: string;
  tenantId: string;
  email: string;
  mustChangePassword: boolean;
}

/** Who a session token belongs to, if it is still valid. */
export async function sessionSubject(token: string | undefined): Promise<SessionSubject | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return withSignInLookup({ tokenHash: sha256(token) }, async (tx, enterTenant) => {
    const [session] = await tx
      .select({ staffId: staffSessions.staffId, tenantId: staffSessions.tenantId })
      .from(staffSessions)
      .where(
        and(
          eq(staffSessions.tokenHash, sha256(token)),
          isNull(staffSessions.revokedAt),
          gt(staffSessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!session) return null;

    await enterTenant(session.tenantId, session.staffId);
    const [row] = await tx
      .select({ email: staffUsers.email, status: staffUsers.status, mustChange: staffCredentials.mustChangePassword })
      .from(staffUsers)
      .leftJoin(staffCredentials, eq(staffCredentials.staffId, staffUsers.id))
      .where(and(eq(staffUsers.tenantId, session.tenantId), eq(staffUsers.id, session.staffId)))
      .limit(1);
    if (!row || row.status !== 'active') return null;
    return {
      authUserId: session.staffId,
      tenantId: session.tenantId,
      email: row.email,
      mustChangePassword: row.mustChange ?? false,
    };
  });
}

/** Ends one session: signing out on this device. */
export async function endSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await withSignInLookup({ tokenHash: sha256(token) }, (tx) =>
    tx
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffSessions.tokenHash, sha256(token)), isNull(staffSessions.revokedAt))),
  );
}

/** A session for a staff member already vouched for: the demonstration picker. */
export async function startSession(db: TenantDb, staffId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(staffSessions).values({
    tenantId: db.tenantId,
    staffId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });
  return token;
}

/** Signs somebody out everywhere, except the session `keepToken` belongs to. */
export async function revokeSessions(db: TenantDb, staffId: string, keepToken?: string): Promise<void> {
  await db
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(staffSessions.tenantId, db.tenantId),
        eq(staffSessions.staffId, staffId),
        isNull(staffSessions.revokedAt),
        ...(keepToken ? [ne(staffSessions.tokenHash, sha256(keepToken))] : []),
      ),
    );
}

/** Sets a password somebody else chose (a new account, a reset). They must change it on next sign-in. */
export async function setTemporaryPassword(db: TenantDb, staffId: string, email: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db
    .insert(staffCredentials)
    .values({ staffId, tenantId: db.tenantId, email: normaliseEmail(email), passwordHash, mustChangePassword: true })
    .onConflictDoUpdate({
      target: staffCredentials.staffId,
      set: {
        passwordHash,
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      },
    });
  await revokeSessions(db, staffId);
}

export type ChangePasswordResult = { ok: true } | { ok: false; problem: PasswordProblem };

/**
 * A staff member replacing their own password.
 *
 * The current password is required even though they are signed in: a laptop
 * left open is not permission to lock its owner out. Every other session ends.
 */
export async function changeOwnPassword(
  db: TenantDb,
  staff: { authUserId: string; email: string },
  input: { current?: string; next: string; confirm: string; keepToken?: string; forced?: boolean },
): Promise<ChangePasswordResult> {
  const [credential] = await db
    .select({ passwordHash: staffCredentials.passwordHash, mustChange: staffCredentials.mustChangePassword })
    .from(staffCredentials)
    .where(and(eq(staffCredentials.tenantId, db.tenantId), eq(staffCredentials.staffId, staff.authUserId)))
    .limit(1);

  // A signed-in session is not a licence to guess the current password.
  const limit = await checkRateLimit({
    bucket: 'password-change',
    subject: sha256(staff.authUserId).slice(0, 32),
    max: 10,
    windowSeconds: 900,
  });
  if (!limit.allowed) return { ok: false, problem: 'too_many_attempts' };

  // Required unless this is the forced change straight after signing in with
  // a temporary password, which has just been checked.
  if (credential && !(input.forced && credential.mustChange)) {
    if (!input.current || !(await verifyPassword(input.current, credential.passwordHash))) {
      return { ok: false, problem: 'wrong_current' };
    }
  }
  if (input.next !== input.confirm) return { ok: false, problem: 'mismatch' };
  const problem = passwordProblem(input.next, staff.email);
  if (problem) return { ok: false, problem };
  if (credential && (await verifyPassword(input.next, credential.passwordHash))) {
    return { ok: false, problem: 'same_as_current' };
  }

  const passwordHash = await hashPassword(input.next);
  await db
    .insert(staffCredentials)
    .values({
      staffId: staff.authUserId,
      tenantId: db.tenantId,
      email: normaliseEmail(staff.email),
      passwordHash,
      mustChangePassword: false,
    })
    .onConflictDoUpdate({
      target: staffCredentials.staffId,
      set: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
    });
  await revokeSessions(db, staff.authUserId, input.keepToken);
  return { ok: true };
}
