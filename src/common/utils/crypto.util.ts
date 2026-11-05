import { createHash, randomBytes, randomInt } from 'crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomNumericCode(length = 6): string {
  return Array.from({ length }, () => randomInt(0, 10)).join('');
}
