import type { Receipt } from './assistant-types';

/**
 * The on-screen confirmation (spec §21).
 *
 * Rendered from the backend's own result, so it states what actually
 * committed. Note the email line: "queued" is not "delivered", and the wording
 * never claims otherwise (spec §21, §54).
 */
export function ConfirmationSlip({ receipt, brandName }: { receipt: Receipt; brandName: string }) {
  return (
    <div className="my-3 rounded border border-ink-900/15 bg-white">
      <div className="border-b border-ink-100 px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.25em] text-ink-500">{brandName}</p>
        <p className="mt-1 text-sm font-medium text-ink-900">{receipt.action}</p>
      </div>
      <dl className="divide-y divide-ink-100 text-sm">
        <Field label="Reference" value={receipt.ticketNumber} mono />
        {receipt.vehicle && <Field label="Vehicle" value={receipt.vehicle} />}
        {receipt.when && <Field label="When" value={receipt.when} />}
        {receipt.confirmationCode && (
          <Field label="Confirmation code" value={receipt.confirmationCode} mono />
        )}
        {receipt.confirmationEmail && (
          <Field label="Email" value={receipt.confirmationEmail} muted />
        )}
      </dl>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  muted = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd
        className={`text-right ${mono ? 'font-mono text-[13px] tabular-nums' : ''} ${
          muted ? 'text-ink-500' : 'text-ink-900'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
