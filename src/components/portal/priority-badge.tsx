const STYLES = {
  high: 'bg-[color:var(--color-signal-high)] text-white',
  medium: 'bg-[color:var(--color-signal-medium)] text-white',
  low: 'bg-ink-100 text-ink-500',
} as const;

/**
 * Internal only. Priority is never rendered on any customer-facing surface
 * (spec §11, §54) — it exists in `src/components/portal/` for that reason.
 */
export function PriorityBadge({ priority }: { priority: 'low' | 'medium' | 'high' }) {
  return (
    <span
      className={`inline-block rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${STYLES[priority]}`}
    >
      {priority}
    </span>
  );
}
