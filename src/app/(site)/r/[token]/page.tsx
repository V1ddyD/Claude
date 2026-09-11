import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { redeemTicketToken } from '@/server/services/tickets/access';
import { isAppError } from '@/server/errors';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your request', robots: { index: false, follow: false } };

/**
 * A customer viewing their own request.
 *
 * Reached only by the single-use link in their confirmation email. There is
 * deliberately no form here and no lookup by email or reference number — that
 * would be a customer-data enumeration endpoint (docs/00-architecture.md §3).
 *
 * Nothing internal is shown: no priority, no score, no staff notes, no
 * assignment. Only what the customer themselves gave us and what we committed
 * to do about it.
 */
export default async function RequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tenant = await resolveTenantByHost((await headers()).get('host'));

  let view;
  try {
    view = await redeemTicketToken(tenant.id, token);
  } catch (error) {
    // Expired, already used, or never real — all the same page.
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <p className="text-[11px] uppercase tracking-[0.3em] text-ink-500">{tenant.brandName}</p>
      <h1 className="mt-4 text-2xl font-medium tracking-tight text-ink-900">{view.subject}</h1>

      <dl className="mt-8 divide-y divide-ink-100 border-y border-ink-100 text-sm">
        <Row label="Reference" value={view.number} mono />
        <Row label="Status" value={view.status.replace(/_/g, ' ')} />
        <Row
          label="Received"
          value={new Intl.DateTimeFormat(tenant.locale, {
            timeZone: tenant.timezone, dateStyle: 'long',
          }).format(view.createdAt)}
        />
        {view.appointment && (
          <>
            <Row
              label="Appointment"
              value={new Intl.DateTimeFormat(tenant.locale, {
                timeZone: tenant.timezone,
                dateStyle: 'full',
                timeStyle: 'short',
                timeZoneName: 'short',
              }).format(view.appointment.startsAt)}
            />
            <Row label="Confirmation code" value={view.appointment.confirmationCode} mono />
          </>
        )}
      </dl>

      <p className="mt-8 text-sm leading-relaxed text-ink-500">
        Keep your reference to hand if you contact us. This link works once — ask the
        assistant if you need to check again, change the time, or cancel.
      </p>
    </main>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`text-right text-ink-900 ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</dd>
    </div>
  );
}
