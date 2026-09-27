import 'server-only';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Staff passwords.
 *
 * scrypt, from Node's own crypto: memory-hard, so a stolen hash is expensive
 * to guess at on a GPU, and no native dependency for the host to build. Each
 * hash carries its own parameters, so they can be raised later without
 * locking anyone out: an old hash still verifies, and is simply stronger the
 * next time that person changes their password.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
// 128 * N * r bytes, with room to spare. Node refuses anything above maxmem.
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Checked when an email matches nobody, so a wrong email takes as long as a
 * wrong password. Otherwise the response time alone would tell a stranger
 * which addresses have accounts.
 */
let dummy: Promise<string> | undefined;
export async function burnTime(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
}

/* -------------------------------------------------------------------------- */
/* What a password must be                                                    */
/* -------------------------------------------------------------------------- */

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;

/** The passwords every guessing tool tries first. */
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd',
  '1234567890', '12345678910', '0123456789', '1111111111', '0000000000', 'qwertyuiop',
  'qwerty1234', 'qwerty12345', 'iloveyou12', 'abcdefghij', 'abc1234567', 'letmein123',
  'welcome123', 'admin12345', 'administrator', 'changeme12', 'brunei1234', 'bandar1234',
]);

/**
 * Everything a password form can be told, by code.
 *
 * Pages show these by code, never text taken from the address bar: a link
 * that could make the portal display any sentence would let a stranger put a
 * convincing warning in front of a business's staff.
 */
export const PASSWORD_MESSAGES = {
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  too_long: 'That password is too long.',
  too_common: 'That password is too common. Choose something less guessable.',
  too_simple: 'That password is too easy to guess.',
  contains_email: "Don't include your email address in your password.",
  wrong_current: 'Your current password was not right.',
  mismatch: "The new passwords don't match.",
  same_as_current: 'Choose a password different from the current one.',
  too_many_attempts: 'Too many attempts. Please wait 15 minutes and try again.',
} as const;

export type PasswordProblem = keyof typeof PASSWORD_MESSAGES;

/** Why a proposed password is not good enough, or null when it is. */
export function passwordProblem(password: string, email: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'too_common';
  if (/^(.)\1+$/.test(password)) return 'too_simple';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'contains_email';
  return null;
}

/**
 * A password somebody else will type once and then replace.
 *
 * No characters that are easily confused (0 and O, 1 and l), because it is
 * read off a screen and typed by hand.
 */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  return `${out.slice(0, 7)}-${out.slice(7)}`;
}
