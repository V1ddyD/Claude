import { notFound } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { withStaff } from '@/server/auth/require-staff';
import { getLeadDetail } from '@/server/db/repositories/leads';
import { allowedNextStatuses } from '@/server/services/leads/actions';
import { staffUsers } from '@/server/db/schema';
import { changeStatusAction, assignLeadAction, addNoteAction } from './actions';
import { PriorityBadge } from '@/components/portal/priority-badge';
import { formatMoney } from '@/server/services/pricing';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lead' };

/**
 * The lead detail page (spec §24).
 *
 * Everything a salesperson needs in order to pick up the phone, without having
 * to reconstruct what happened: the extracted facts with their confidence and
 * source, the AI summary, the appointment, the ticket, and the complete
 * conversation.
 */
export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const { detail, staff, colleagues } = await withStaff(
    'lead.read.assigned',
    async (db, currentStaff) => ({
      detail: await getLeadDetail(db, currentStaff, id),
      staff: {
        role: currentStaff.role,
        canAssign: currentStaff.can('lead.assign'),
        canWriteStatus: currentStaff.can('lead.status.write'),
        canNote: currentStaff.can('lead.note.write'),
      },
      // Only offered when the viewer may actually assign — the list of who
      // works here is not something every role needs to see.
      colleagues: currentStaff.can('lead.assign')
        ? await db
            .select({ id: staffUsers.id, fullName: staffUsers.fullName, role: staffUsers.role })
            .from(staffUsers)
            .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.status, 'active')))
        : [],
    }),
  );
  // A lead outside this staff member's visibility is "not found", not
  // "forbidden": distinguishing them confirms the record exists.
  if (!detail) notFound();

  const { lead, customer, signals, timeline, transcript, appointments, tickets, notes } = detail;
  const nextStatuses = allowedNextStatuses(lead.status);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div>
        <div className="flex items-center gap-3">
          <PriorityBadge priority={lead.priority} />
          <h1 className="text-2xl font-medium tracking-tight text-ink-900">
            {customer.fullName ?? 'Unnamed customer'}
          </h1>
          <span className="text-sm text-ink-500">score {lead.score}</span>
        </div>

        {lead.scoreRationale && (
          <p className="mt-2 text-sm text-ink-500">{lead.scoreRationale}</p>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded border border-accent-600/30 bg-accent-600/5 px-4 py-3 text-sm text-accent-600"
          >
            {error}
          </p>
        )}

        {lead.aiSummary && (
          <section className="mt-6 rounded border border-ink-100 bg-white p-5">
            <h2 className="text-[11px] uppercase tracking-wider text-ink-500">Summary</h2>
            <p className="mt-2 leading-relaxed text-ink-900">{lead.aiSummary}</p>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-[11px] uppercase tracking-wider text-ink-500">Conversation</h2>
          <div className="mt-3 space-y-3">
            {transcript.length === 0 && <p className="text-sm text-ink-500">No conversation.</p>}
            {transcript.map((message, i) =>
              message.role === 'tool' ? (
                // Shown, but visibly secondary: staff should be able to see
                // what the assistant looked up without it dominating the thread.
                <p key={i} className="pl-4 text-xs text-ink-300">
                  looked up {message.toolName}
                </p>
              ) : (
                <div
                  key={i}
                  className={
                    message.role === 'user'
                      ? 'rounded border border-ink-100 bg-white p-4'
                      : 'rounded bg-ink-100/60 p-4'
                  }
                >
                  <p className="text-[11px] uppercase tracking-wider text-ink-500">
                    {message.role === 'user' ? 'Customer' : 'Assistant'}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap leading-relaxed text-ink-900">
                    {message.content}
                  </p>
                </div>
              ),
            )}
          </div>
        </section>
      </div>

      <aside className="space-y-6">
        <Panel title="Working this lead">
          <div className="space-y-4 pt-1">
            <p className="text-sm text-ink-900">
              Status: <span className="font-medium">{lead.status.replace(/_/g, ' ')}</span>
            </p>

            {staff.canWriteStatus && nextStatuses.length > 0 && (
              <form action={changeStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                {nextStatuses.map((status) => (
                  <button
                    key={status}
                    type="submit"
                    name="status"
                    value={status}
                    className="rounded border border-ink-100 bg-white px-2.5 py-1 text-xs text-ink-900 transition-colors hover:border-ink-300"
                  >
                    {status.replace(/_/g, ' ')}
                  </button>
                ))}
              </form>
            )}
            {nextStatuses.length === 0 && (
              <p className="text-xs text-ink-500">This lead is closed.</p>
            )}

            {staff.canAssign && (
              <form action={assignLeadAction} className="flex gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <label htmlFor="assign" className="sr-only">
                  Assign to
                </label>
                <select
                  id="assign"
                  name="staffId"
                  defaultValue={lead.assignedStaffId ?? ''}
                  className="flex-1 rounded border border-ink-100 bg-white px-2 py-1.5 text-sm text-ink-900"
                >
                  <option value="">Unassigned</option>
                  {colleagues.map((colleague) => (
                    <option key={colleague.id} value={colleague.id}>
                      {colleague.fullName} · {colleague.role}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded bg-ink-900 px-3 py-1.5 text-xs text-white hover:bg-ink-800"
                >
                  Assign
                </button>
              </form>
            )}
          </div>
        </Panel>

        <Panel title="Contact">
          <Row label="Email" value={customer.email} />
          <Row label="Phone" value={customer.phone} />
          <Row
            label="Contact consent"
            value={customer.contactConsent ? 'Given' : 'Not given'}
          />
        </Panel>

        <Panel title="What we know">
          {signals.length === 0 && <p className="text-sm text-ink-500">Nothing extracted yet.</p>}
          {signals.map((signal) => (
            <div key={signal.field} className="flex items-baseline justify-between gap-3 py-1">
              <span className="text-xs text-ink-500">{humanise(signal.field)}</span>
              <span className="text-right text-sm text-ink-900">
                {formatValue(signal.field, signal.value)}
                {/* Confidence and provenance, so staff can tell a stated fact
                    from an inferred one (spec §26). */}
                <span className="ml-2 text-[11px] text-ink-300">
                  {Math.round(Number(signal.confidence) * 100)}% · {signal.source}
                </span>
              </span>
            </div>
          ))}
        </Panel>

        {appointments.length > 0 && (
          <Panel title="Appointments">
            {appointments.map((appointment) => (
              <div key={appointment.id} className="py-1 text-sm">
                <span className="text-ink-900">
                  {new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Toronto',
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(appointment.startsAt)}
                </span>
                <span className="block text-xs text-ink-500">
                  {appointment.type.replace(/_/g, ' ')} · {appointment.status} ·{' '}
                  {appointment.confirmationCode}
                </span>
              </div>
            ))}
          </Panel>
        )}

        {tickets.length > 0 && (
          <Panel title="Tickets">
            {tickets.map((ticket) => (
              <div key={ticket.number} className="flex justify-between py-1 text-sm">
                <span className="tabular-nums text-ink-900">{ticket.number}</span>
                <span className="text-xs text-ink-500">{ticket.status}</span>
              </div>
            ))}
          </Panel>
        )}

        <Panel title="Activity">
          {timeline.map((event, i) => (
            <div key={i} className="py-1">
              <p className="text-sm text-ink-900">{event.summary}</p>
              <p className="text-[11px] text-ink-500">
                {event.actorType} ·{' '}
                {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
                  event.createdAt,
                )}
              </p>
            </div>
          ))}
        </Panel>

        <Panel title="Staff notes">
          {staff.canNote && (
            <form action={addNoteAction} className="space-y-2 pb-3 pt-1">
              <input type="hidden" name="leadId" value={lead.id} />
              <label htmlFor="note" className="sr-only">
                Add an internal note
              </label>
              <textarea
                id="note"
                name="body"
                rows={2}
                maxLength={2000}
                placeholder="Internal note — never shown to the customer"
                className="w-full resize-none rounded border border-ink-100 bg-white p-2 text-sm text-ink-900 placeholder:text-ink-300"
              />
              <button
                type="submit"
                className="rounded bg-ink-900 px-3 py-1.5 text-xs text-white hover:bg-ink-800"
              >
                Add note
              </button>
            </form>
          )}
          {notes.length === 0 && (
            <p className="text-sm text-ink-500">
              No notes. These are internal and never shown to the customer.
            </p>
          )}
          {notes.map((note, i) => (
            <p key={i} className="py-1 text-sm text-ink-900">
              {note.body}
              <span className="block text-[11px] text-ink-500">{note.author}</span>
            </p>
          ))}
        </Panel>
      </aside>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-ink-100 bg-white p-5">
      <h2 className="text-[11px] uppercase tracking-wider text-ink-500">{title}</h2>
      <div className="mt-3 divide-y divide-ink-100">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-xs text-ink-500">{label}</span>
      <span className="text-sm text-ink-900">{value ?? '—'}</span>
    </div>
  );
}

function humanise(field: string): string {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ Cents$/, '');
}

function formatValue(field: string, value: unknown): string {
  if (field === 'budgetCents' && typeof value === 'number') {
    return formatMoney(value, 'CAD', 'en-CA');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.replace(/_/g, ' ');
  return String(value);
}
