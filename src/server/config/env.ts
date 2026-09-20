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

  /**
   * A role to assume for the duration of every request transaction.
   *
   * The design wants the request path connecting as an unprivileged role, so
   * that RLS and the table grants apply to it. Two connection strings is the
   * direct way to get that and it is what a self-managed Postgres gives you.
   *
   * A managed platform often gives you ONE role, which owns the tables. Naming
   * a role here makes every tenant transaction `SET LOCAL ROLE` to it first,
   * which reaches the same privilege posture from a single credential: the
   * query runs as that role, RLS evaluates against it, and the role reverts
   * when the transaction ends.
   *
   * An identifier, not a string: it cannot be a bound parameter in SET ROLE, so
   * the shape is constrained here rather than escaped at the call site.
   */
  DATABASE_REQUEST_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'DATABASE_REQUEST_ROLE must be a plain lowercase identifier')
    .optional(),

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

  /**
   * Meta's messaging platforms — Instagram, Messenger, WhatsApp.
   *
   * One app secret covers all three, because they are one app. The per-account
   * send token is NOT here: it belongs to a dealership, not to the deployment,
   * and lives in `channel_accounts` so a second tenant can be connected
   * without an environment change.
   *
   * The verify token is a string we choose and type into Meta's webhook form.
   * It authenticates the subscription handshake only — every real delivery is
   * authenticated by an HMAC signature over the body instead.
   */
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  SESSION_SECRET: z.string().min(32).optional(),
  CRON_SECRET: z.string().optional(),

  /**
   * A publicly reachable demonstration deployment.
   *
   * This exists for one reason: showing the Dealer Portal to a prospect. The
   * portal normally requires a real identity provider and the development
   * staff picker refuses to load in production, which is correct and which
   * also leaves a demo site with half a product visible.
   *
   * Demo mode permits the staff picker on a deployed instance, BEHIND A
   * PASSWORD. Not decoration: a public chatbot collects whatever a visitor
   * types, and some of them will type a real name and a real email address. A
   * world-readable portal would publish those to anyone who found the URL.
   *
   * Never set this on a deployment holding a real dealership's data.
   */
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  /** Required whenever DEMO_MODE is on. Handed to whoever is being shown it. */
  DEMO_PORTAL_PASSWORD: z.string().min(8).optional(),

  /**
   * Whether a starting server applies pending migrations itself.
   *
   * Unset means "a demonstration deployment does, a real one does not", which
   * is the right default in both directions: a demo has no operator standing
   * by, and a dealership's live database should change under supervision.
   */
  AUTO_MIGRATE: z.enum(['true', 'false']).optional(),

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

  // The platform may have provisioned the database and named the variable
  // itself. Mapped rather than duplicated, so nothing downstream has to know
  // which host it is running on.
  if (!process.env.DATABASE_URL && process.env.NETLIFY_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.NETLIFY_DATABASE_URL;
  }
  if (!process.env.DATABASE_ADMIN_URL && process.env.NETLIFY_DATABASE_URL_UNPOOLED) {
    process.env.DATABASE_ADMIN_URL = process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  }

  // An empty variable is not a configured value.
  //
  // `.env.example` ships keys with nothing after the `=`, which is how an
  // operator is shown what exists without being given a fake value. Passed
  // through as empty strings those fail `min(32)` and enum checks, so copying
  // the example file would stop the application booting — which is precisely
  // the moment somebody is trying it for the first time.
  const configured = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const parsed = schema.safeParse(configured);
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

  const demo = parsed.data.DEMO_MODE === 'true';

  // A demo without a portal password would publish whatever visitors typed
  // into the chat. Refused at boot rather than discovered later.
  if (demo && !parsed.data.DEMO_PORTAL_PASSWORD) {
    throw new Error(
      'DEMO_MODE=true requires DEMO_PORTAL_PASSWORD (8+ characters). The demo portal ' +
        'shows leads built from what visitors typed, so it is not left open.',
    );
  }

  // Production must have the real thing. Development may run without optional
  // secrets — each absence degrades one named feature rather than faking it.
  if (parsed.data.NODE_ENV === 'production') {
    const required = [['SESSION_SECRET', parsed.data.SESSION_SECRET]] as const;

    // A demonstration deployment has no identity provider by design; anything
    // else in production must have one.
    const identity = demo
      ? []
      : ([
          ['NEXT_PUBLIC_SUPABASE_URL', parsed.data.NEXT_PUBLIC_SUPABASE_URL],
          ['NEXT_PUBLIC_SUPABASE_ANON_KEY', parsed.data.NEXT_PUBLIC_SUPABASE_ANON_KEY],
        ] as const);

    const missing = [...required, ...identity]
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
  /**
   * Inbound messaging webhooks are accepted.
   *
   * Requires the app secret specifically. Without it a delivery cannot be
   * authenticated, and an unauthenticated webhook is an anonymous stranger
   * able to put words in a customer's mouth and read the reply.
   */
  get messagingWebhooks() {
    return Boolean(env.META_APP_SECRET);
  },
  /**
   * The password-gated staff picker is available.
   *
   * Requires the flag, a password, and the absence of a real identity
   * provider — a deployment with Supabase configured uses Supabase, and this
   * cannot override it.
   */
  get demoPortal() {
    return (
      env.DEMO_MODE === 'true' &&
      Boolean(env.DEMO_PORTAL_PASSWORD) &&
      !features.supabaseAuth
    );
  },
};
