/**
 * A fact about a lead, at a glance.
 *
 * Small and quiet by default: a row carries several of these and they are meant
 * to be taken in together, not read one at a time. `good` marks the one thing
 * that changes what a salesperson does — a customer already in the diary.
 */
const TONES = {
  neutral: 'border-ink-100 bg-ink-50 text-ink-500',
  good: 'border-transparent bg-ink-900 text-white',
} as const;

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={`inline-block rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
