import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Jeton de suivi d'une commande anonyme : HMAC de son identifiant.
 * Dérivé (et non stocké), il peut être renvoyé à l'identique lorsqu'un client
 * rejoue une création de commande avec la même clé d'idempotence.
 */
export function signOrderToken(secret: string, orderId: string): string {
  return createHmac('sha256', secret)
    .update(`order-tracking:${orderId}`)
    .digest('base64url');
}

export function verifyOrderToken(
  secret: string,
  orderId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const expected = Buffer.from(signOrderToken(secret, orderId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
