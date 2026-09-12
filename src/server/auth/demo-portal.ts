import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env, features } from '@/server/config/env';

/**
 * The demonstration portal password.
 *
 * A public demonstration site lets anyone find the Dealer Portal, and the
 * portal shows leads assembled from whatever visitors typed into the chat —
 * some of which will be a real name and a real email address. So the staff
 * picker is reachable there only behind this, and only on a deployment that
 * has explicitly declared itself a demonstration.
 *
 * Its own module so it can be tested as a function rather than asserted about
 * as source text: a gate nobody has actually run is not a gate.
 */

/** True when the supplied password unlocks the demonstration staff picker. */
export function verifyDemoPassword(supplied: string): boolean {
  if (!features.demoPortal) return false;
  return matches(supplied, env.DEMO_PORTAL_PASSWORD ?? '');
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, and throwing
 * would itself disclose the length, so both sides are hashed to a fixed width
 * first. An unset expected value never matches, including against an empty
 * submission.
 */
export function matches(supplied: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
