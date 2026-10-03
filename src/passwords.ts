import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

let dummyHash: Promise<string> | undefined;

export function assertPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 200) {
    throw new HttpError(400, 'VALIDATION', 'Password must be 10 to 200 characters.');
  }
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = await deriveKey(password, salt, KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${key.toString('base64url')}`;
}

export function warmupPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] ?? '';
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) {
    return false;
  }
  const actual = await deriveKey(password, salt, expected.length, n, r, p);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function deriveKey(password: string, salt: string, keyLength: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { N: n, r, p }, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}
