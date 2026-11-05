import {
  generateApiKey,
  looksLikeApiKey,
  MAX_ATTEMPTS,
  nextAttemptDelay,
  rejectWebhookUrl,
  signWebhook,
  verifyWebhookSignature,
} from './integrations.rules';

describe('règles des intégrations', () => {
  it('génère des clés d’API reconnaissables', () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith(`${prefix}_`)).toBe(true);
    expect(looksLikeApiKey(key)).toBe(true);
    expect(looksLikeApiKey('qro_12345678_court')).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
  });

  it('signe et vérifie un webhook, en refusant les rejeux', () => {
    const body = JSON.stringify({ type: 'order.created' });
    const now = 1_800_000_000;
    const header = signWebhook('whsec_test', body, now);
    expect(
      verifyWebhookSignature('whsec_test', body, header, 300, now + 10),
    ).toBe(true);
    expect(verifyWebhookSignature('whsec_autre', body, header, 300, now)).toBe(
      false,
    );
    expect(
      verifyWebhookSignature('whsec_test', `${body} `, header, 300, now),
    ).toBe(false);
    // Signature valide mais trop ancienne : rejeu refusé.
    expect(
      verifyWebhookSignature('whsec_test', body, header, 300, now + 301),
    ).toBe(false);
    expect(verifyWebhookSignature('whsec_test', body, 'n-importe-quoi')).toBe(
      false,
    );
  });

  it('espace les nouvelles tentatives puis abandonne', () => {
    expect(nextAttemptDelay(1)).toBe(60_000);
    expect(nextAttemptDelay(2)).toBe(300_000);
    expect(nextAttemptDelay(MAX_ATTEMPTS - 1)).toBe(12 * 3_600_000);
    expect(nextAttemptDelay(MAX_ATTEMPTS)).toBeNull();
  });

  it('bloque les destinations internes en production (SSRF)', () => {
    const prod = (url: string) => rejectWebhookUrl(url, true);
    expect(prod('https://pos.exemple.sn/webhooks')).toBeNull();
    expect(prod('http://pos.exemple.sn/webhooks')).toBe('HTTPS obligatoire');
    expect(prod('https://localhost/x')).toBe('Hôte interne interdit');
    expect(prod('https://127.0.0.1/x')).toBe('Adresse IP privée interdite');
    expect(prod('https://10.0.0.5/x')).toBe('Adresse IP privée interdite');
    expect(prod('https://192.168.1.10/x')).toBe('Adresse IP privée interdite');
    expect(prod('https://169.254.169.254/latest/meta-data')).toBe(
      'Adresse IP privée interdite',
    );
    expect(prod('https://[::1]/x')).toBe('Adresse IP privée interdite');
    expect(prod('https://user:pass@exemple.sn/x')).toBe(
      'Identifiants interdits dans l’URL',
    );
    expect(prod('ftp://exemple.sn')).toBe('Protocole non pris en charge');
    // Hors production, localhost est accepté (développement, tests).
    expect(rejectWebhookUrl('http://localhost:4000/hook', false)).toBeNull();
  });
});
