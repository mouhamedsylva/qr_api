import type Stripe from 'stripe';

/**
 * Pays où Stripe ouvre des comptes marchands complets (encaissement par carte
 * au nom du restaurant). Ailleurs — notamment en Afrique de l'Ouest (SN, CI,
 * ML, BF…) — Stripe ne propose que les « versements internationaux » :
 * la plateforme encaisse, puis transfère au compte du restaurant.
 * Référence : liste des pays pris en charge par Stripe (stripe.com/global).
 */
export const STRIPE_MERCHANT_COUNTRIES = new Set([
  'AE',
  'AT',
  'AU',
  'BE',
  'BG',
  'BR',
  'CA',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GI',
  'GR',
  'HK',
  'HR',
  'HU',
  'IE',
  'IN',
  'IT',
  'JP',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'MX',
  'MY',
  'NL',
  'NO',
  'NZ',
  'PL',
  'PT',
  'RO',
  'SE',
  'SG',
  'SI',
  'SK',
  'TH',
  'US',
]);

export type ConnectMode = 'merchant' | 'recipient';

export function connectMode(country: string): ConnectMode {
  return STRIPE_MERCHANT_COUNTRIES.has(country.toUpperCase())
    ? 'merchant'
    : 'recipient';
}

/** Paramètres de création du compte connecté Express du restaurant. */
export function connectAccountParams(restaurant: {
  id: string;
  name: string;
  country: string;
  email: string | null;
}): Stripe.AccountCreateParams {
  const mode = connectMode(restaurant.country);
  const base: Stripe.AccountCreateParams = {
    type: 'express',
    country: restaurant.country.toUpperCase(),
    email: restaurant.email ?? undefined,
    business_profile: { name: restaurant.name },
    metadata: { restaurantId: restaurant.id },
  };
  if (mode === 'merchant') {
    return {
      ...base,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    };
  }
  // Compte « destinataire » : reçoit les transferts de la plateforme.
  return {
    ...base,
    tos_acceptance: { service_agreement: 'recipient' },
    capabilities: { transfers: { requested: true } },
  };
}

/** Le restaurant peut recevoir des paiements par carte : encaissement direct ou transferts actifs. */
export function isConnectReady(
  account: Pick<Stripe.Account, 'charges_enabled' | 'capabilities'>,
): boolean {
  return (
    account.charges_enabled === true ||
    account.capabilities?.transfers === 'active'
  );
}
