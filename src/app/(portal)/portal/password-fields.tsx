import { MIN_PASSWORD_LENGTH } from '@/server/auth/passwords';

/** The fields of a password change. Shared by the forced first sign-in and the account page. */
export function PasswordFields({ askCurrent }: { askCurrent: boolean }) {
  return (
    <div className="space-y-4">
      {askCurrent && (
        <Field label="Current password" name="current" autoComplete="current-password" />
      )}
      <Field label="New password" name="next" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
      <Field label="Confirm new password" name="confirm" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
      <p className="text-xs text-ink-500">
        At least {MIN_PASSWORD_LENGTH} characters. A few unrelated words make a strong, memorable password.
      </p>
    </div>
  );
}

function Field({
  label, name, autoComplete, minLength,
}: { label: string; name: string; autoComplete: string; minLength?: number }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-ink-500">{label}</span>
      <input
        type="password"
        name={name}
        required
        minLength={minLength}
        maxLength={128}
        autoComplete={autoComplete}
        className="mt-1 w-full border border-ink-100 bg-white px-3 py-2.5 text-sm"
      />
    </label>
  );
}
