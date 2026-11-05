import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

// ───────────────────────── Clés d'API (INT-01) ─────────────────────────

/** Droits attribuables à une clé. */
export const API_SCOPES = ['menu:read', 'orders:read', 'orders:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * Clé au format `qro_<préfixe>_<secret>` : le préfixe (visible) identifie la
 * clé dans le back-office, le secret n'est montré qu'une fois.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const prefix = `qro_${randomBytes(4).toString('hex')}`;
  return { key: `${prefix}_${randomBytes(24).toString('base64url')}`, prefix };
}

export function looksLikeApiKey(value: string | undefined): value is string {
  return !!value && /^qro_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/.test(value);
}

// ───────────────────────── Webhooks (INT-02) ─────────────────────────

/** Événements qu'un système tiers peut recevoir. */
export const WEBHOOK_EVENTS = [
  'order.created',
  'order.status_changed',
  'order.items_added',
  'order.payment_updated',
  'menu.item_updated',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * En-tête `X-QROrder-Signature: t=<horodatage>,v1=<hmac>` où
 * hmac = HMAC-SHA256(secret, "<horodatage>.<corps>"). L'horodatage signé
 * permet au destinataire de refuser les rejeux.
 */
export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Vérification côté destinataire (fournie pour la documentation et les tests). */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=') as [string, string]),
  );
  const t = Number(parts.t);
  if (
    !Number.isInteger(t) ||
    Math.abs(now - t) > toleranceSeconds ||
    !parts.v1
  ) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, body, t).split('v1=')[1]);
  const actual = Buffer.from(parts.v1);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Délais entre tentatives : 1 min, 5 min, 30 min, 2 h, 12 h, puis abandon. */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  12 * 3_600_000,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Prochaine tentative après `attempts` échecs ; null = abandon. */
export function nextAttemptDelay(attempts: number): number | null {
  return attempts >= MAX_ATTEMPTS
    ? null
    : (RETRY_DELAYS_MS[attempts - 1] ?? null);
}

/**
 * Protection SSRF : en production, seules des URL HTTPS vers des hôtes
 * publics sont acceptées (pas d'adresse IP privée, de boucle locale ni de
 * nom interne). Renvoie le motif de refus, ou null si l'URL est acceptée.
 */
export function rejectWebhookUrl(
  raw: string,
  production: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL invalide';
  }
  if (!['https:', 'http:'].includes(url.protocol))
    return 'Protocole non pris en charge';
  if (!production) return null;
  if (url.protocol !== 'https:') return 'HTTPS obligatoire';
  if (url.username || url.password) return 'Identifiants interdits dans l’URL';

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return 'Hôte interne interdit';
  }
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    const privateV4 =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (privateV4) return 'Adresse IP privée interdite';
  }
  if (
    version === 6 &&
    (host === '::1' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:'))
  ) {
    return 'Adresse IP privée interdite';
  }
  return null;
}
