import 'server-only';
import { z } from 'zod';

/**
 * Server environment. Validated once at startup so a missing secret is a boot
 * failure with a clear message, not a 500 during a customer's booking.
 *
 * Nothing here may ever be given a NEXT_PUBLIC_ prefix.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_ADMIN_URL: z.string().optional(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  /**
   * Which AI implementation answers customers.
   *
   * 'scripted' is the deterministic assistant: no credential, no network, the
   * same tools. 'anthropic' is the model. 'auto' — the default — is
   * 'anthropic' when a credential exists and 'scripted' when none does, so a
   * fresh checkout works and a configured deployment uses the model.
   *
   * Selecting 'scripted' explicitly must never require a credential, and
   * selecting 'anthropic' without one is a configuration error worth hearing
   * about at boot rather than in front of a customer.
   */
  AI_PROVIDER: z.enum(['auto', 'scripted', 'anthropic']).default('auto'),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Alternative credential the SDK resolves on its own. */
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  SESSION_SECRET: z.string().min(32).optional(),
  CRON_SECRET: z.string().optional(),

  DEFAULT_TENANT_SLUG: z.string().default('sinclair'),
});

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validation is lazy — on first read, not on import.
 *
 * `next build` imports server modules to collect route configuration, and a
 * build machine legitimately has no DATABASE_URL. Validating at import time
 * would make every build require production secrets, which is both awkward and
 * a reason for people to put secrets where they do not belong.
 *
 * The first read happens during the first request, so a misconfigured
 * deployment still fails immediately and loudly rather than midway through a
 * customer's booking.
 */
function load(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid server environment:\n${issues.join('\n')}`);
  }

  // Asking for the model without a credential is a misconfiguration, and the
  // useful moment to say so is at boot. Asking for the scripted assistant
  // never requires one.
  if (parsed.data.AI_PROVIDER === 'anthropic' && !parsed.data.ANTHROPIC_API_KEY && !parsed.data.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      'AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN. ' +
        'Use AI_PROVIDER=scripted (or leave it unset) to run without a credential.',
    );
  }

  // Production must have the real thing. Development may run without optional
  // secrets — each absence degrades one named feature rather than faking it.
  if (parsed.data.NODE_ENV === 'production') {
    const missing = (
      [
        ['SESSION_SECRET', parsed.data.SESSION_SECRET],
        ['NEXT_PUBLIC_SUPABASE_URL', parsed.data.NEXT_PUBLIC_SUPABASE_URL],
        ['NEXT_PUBLIC_SUPABASE_ANON_KEY', parsed.data.NEXT_PUBLIC_SUPABASE_ANON_KEY],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing required production environment: ${missing.join(', ')}`);
    }
  }

  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get: (_target, key: string) => load()[key as keyof Env],
  has: (_target, key: string) => key in load(),
  ownKeys: () => Reflect.ownKeys(load()),
  getOwnPropertyDescriptor: (_target, key) =>
    Reflect.getOwnPropertyDescriptor(load(), key),
});

export const isProduction = process.env.NODE_ENV === 'production';
export const isTest = process.env.NODE_ENV === 'test';

export const features = {
  /** Staff auth is backed by Supabase; otherwise the development adapter. */
  get supabaseAuth() {
    return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  get ai() {
    // Either credential the SDK understands. An `ant auth login` profile is
    // not visible here, so a key or token remains the supported path for a
    // deployment; the client itself still falls back to a profile if present.
    return Boolean(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN);
  },
  /**
   * The AI implementation to use, with 'auto' resolved.
   *
   * One place decides. Nothing downstream reads AI_PROVIDER or checks for a
   * key, so there is no second opinion about which assistant is running.
   */
  get aiProvider(): 'scripted' | 'anthropic' {
    if (env.AI_PROVIDER === 'scripted') return 'scripted';
    if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
    return features.ai ? 'anthropic' : 'scripted';
  },
  get email() {
    return Boolean(env.RESEND_API_KEY);
  },
};
