import { notFound } from 'next/navigation';
import { withStaff } from '@/server/auth/require-staff';
import { getLeadDetail } from '@/server/db/repositories/leads';
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
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const detail = await withStaff('lead.read.assigned', (db, staff) =>
    getLeadDetail(db, staff, id),
  );
  // A lead outside this staff member's visibility is "not found", not
  // "forbidden": distinguishing them confirms the record exists.
  if (!detail) notFound();

  const { lead, customer, signals, timeline, transcript, appointments, tickets, notes } = detail;

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
