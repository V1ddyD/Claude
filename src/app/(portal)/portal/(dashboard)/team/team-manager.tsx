'use client';

import { useActionState, useEffect, useState } from 'react';
import type { StaffRole } from '@/server/db/schema';
import type { TeamResult } from '@/server/services/team';
import { addMemberAction, memberAction } from './actions';

const ROLE_LABEL: Record<StaffRole, string> = {
  admin: 'Owner',
  manager: 'Manager',
  sales: 'Sales',
  service: 'Service',
};

const ROLE_HELP: Record<StaffRole, string> = {
  admin: 'Everything, including managing the team',
  manager: 'All leads, and can add sales and service staff',
  sales: 'Their own and unassigned leads',
  service: 'Service tickets and appointments',
};

export interface MemberRow {
  id: string;
  fullName: string;
  email: string;
  role: StaffRole;
  lastSignIn: string | null;
  isYou: boolean;
  manageable: boolean;
}

/** A message from the last action, and a temporary password if one was made. */
function Outcome({ result }: { result: TeamResult | null }) {
  const [copied, setCopied] = useState(false);
  if (!result) return null;
  return (
    <div
      role={result.ok ? 'status' : 'alert'}
      className={`mt-4 border-l-2 px-3 py-2 text-sm ${result.ok ? 'border-ink-900 bg-white text-ink-900' : 'border-accent-600 bg-white text-accent-600'}`}
    >
      <p>{result.message}</p>
      {result.ok && result.temporaryPassword && (
        <div className="mt-3 rounded border border-ink-100 bg-ink-50 p-3">
          <p className="text-xs text-ink-500">Sign in at this portal with</p>
          <p className="mt-1 break-all text-sm text-ink-900">{result.email}</p>
          <p className="mt-1 font-mono text-base tracking-wider text-ink-900">{result.temporaryPassword}</p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(result.temporaryPassword ?? '');
              setCopied(true);
            }}
            className="mt-2 text-xs text-ink-900 underline underline-offset-2"
          >
            {copied ? 'Copied' : 'Copy password'}
          </button>
          <p className="mt-2 text-xs text-ink-500">
            This is shown once. Send it to them privately; they'll be asked to choose their own password.
          </p>
        </div>
      )}
    </div>
  );
}

export function AddMember({ assignable, full }: { assignable: StaffRole[]; full: boolean }) {
  const [result, action, pending] = useActionState(addMemberAction, null);
  return (
    <section className="rounded border border-ink-100 bg-white p-4">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-ink-500">Add a staff member</h2>
      {full ? (
        <p className="mt-3 text-sm text-ink-500">
          Every staff account in your package is in use. Remove someone to add another, or ask us about upgrading.
        </p>
      ) : (
        <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-ink-500">Full name</span>
            <input name="fullName" required maxLength={80} className="mt-1 w-full border border-ink-100 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Email</span>
            <input name="email" type="email" required maxLength={254} className="mt-1 w-full border border-ink-100 px-3 py-2 text-sm" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-ink-500">Role</span>
            <select name="role" defaultValue={assignable.includes('sales') ? 'sales' : assignable[0]} className="mt-1 w-full border border-ink-100 bg-white px-3 py-2 text-sm">
              {assignable.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}: {ROLE_HELP[role]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending}
            className="bg-ink-900 px-5 py-2.5 text-sm text-white hover:bg-ink-800 disabled:opacity-60 sm:col-span-2 sm:justify-self-start"
          >
            {pending ? 'Adding…' : 'Add staff member'}
          </button>
        </form>
      )}
      <Outcome result={result} />
    </section>
  );
}

export function MemberCard({ member, assignable }: { member: MemberRow; assignable: StaffRole[] }) {
  const [result, action, pending] = useActionState(memberAction, null);
  const [confirming, setConfirming] = useState<'remove' | 'reset' | null>(null);
  // Closed once the server has answered, not on click: closing it on click
  // unmounted the form before its request was sent.
  useEffect(() => {
    if (result) setConfirming(null);
  }, [result]);

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-sm ${result?.ok && result.removed ? 'text-ink-300 line-through' : 'text-ink-900'}`}>
            {member.fullName} {member.isYou && <span className="text-xs text-ink-500">(you)</span>}
          </p>
          <p className="break-all text-xs text-ink-500">{member.email}</p>
        </div>
        <div className="text-right text-xs text-ink-500">
          <p className="uppercase tracking-wider">{ROLE_LABEL[member.role]}</p>
          <p>{member.lastSignIn ? `Last signed in ${member.lastSignIn}` : 'Not signed in yet'}</p>
        </div>
      </div>

      {member.manageable && !(result?.ok && result.removed) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={action} className="flex items-center gap-2">
            <input type="hidden" name="staffId" value={member.id} />
            <input type="hidden" name="intent" value="role" />
            <select
              name="role"
              defaultValue={member.role}
              aria-label={`Role for ${member.fullName}`}
              className="border border-ink-100 bg-white px-2 py-1.5 text-xs"
            >
              {assignable.map((role) => (
                <option key={role} value={role}>{ROLE_LABEL[role]}</option>
              ))}
            </select>
            <button type="submit" disabled={pending} className="border border-ink-100 px-3 py-1.5 text-xs hover:bg-ink-50">
              Save role
            </button>
          </form>

          {(['reset', 'remove'] as const).map((intent) =>
            confirming === intent ? (
              <form key={intent} action={action} className="flex items-center gap-2">
                <input type="hidden" name="staffId" value={member.id} />
                <input type="hidden" name="intent" value={intent} />
                <span className="text-xs text-ink-500">
                  {intent === 'remove' ? `Remove ${member.fullName}?` : 'Reset their password?'}
                </span>
                <button
                  type="submit"
                  disabled={pending}
                  className="bg-ink-900 px-3 py-1.5 text-xs text-white"
                >
                  Yes
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="px-2 py-1.5 text-xs text-ink-500">
                  Cancel
                </button>
              </form>
            ) : (
              <button
                key={intent}
                type="button"
                onClick={() => setConfirming(intent)}
                className={`border px-3 py-1.5 text-xs hover:bg-ink-50 ${intent === 'remove' ? 'border-accent-600 text-accent-600' : 'border-ink-100 text-ink-900'}`}
              >
                {intent === 'remove' ? 'Remove' : 'Reset password'}
              </button>
            ),
          )}
        </div>
      )}
      <Outcome result={result} />
    </li>
  );
}
