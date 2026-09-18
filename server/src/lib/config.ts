import crypto from 'node:crypto';
import path from 'node:path';

// Keep all user submissions outside the source tree in production.
export const DATA_DIR = process.env.BENEFITS_DATA_DIR || path.join(process.cwd(), 'data');

// An unset admin token must never grant access, including when ?token= is empty.
export function hasAdminAccess(candidate: string | null): candidate is string {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected || !candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function hasBossAnonSalt(): boolean {
  return Boolean(process.env.BOSS_ANON_SALT?.trim());
}

export function bossAnonSalt(): string {
  const value = process.env.BOSS_ANON_SALT?.trim();
  if (!value) throw new Error('BOSS_ANON_SALT is required');
  return value;
}