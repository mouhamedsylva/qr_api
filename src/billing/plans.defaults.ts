/** Feature flags pilotés par les forfaits (ADM-04). */
export const FEATURES = [
  'online_payments',
  'analytics',
  'loyalty',
  'promotions',
  'kds',
  'inventory',
  'api',
  'white_label',
] as const;
export type Feature = (typeof FEATURES)[number];

/** Forfait appliqué quand l'abonnement est expiré, suspendu ou absent. */
export const FALLBACK_PLAN_CODE = 'STARTER';
/** Forfait proposé en essai à l'inscription. */
export const TRIAL_PLAN_CODE = 'PRO';

/**
 * Forfaits par défaut (§10 du cahier des charges), créés au démarrage s'ils
 * n'existent pas. Les prix sont indicatifs (« à valider commercialement ») et
 * modifiables par l'administration.
 */
export const DEFAULT_PLANS = [
  {
    code: 'STARTER',
    name: 'Starter',
    priceMonthly: 15_000,
    priceYearly: 150_000,
    maxRestaurants: 1,
    maxTables: 10,
    maxMembers: 3,
    features: ['online_payments'],
    position: 0,
  },
  {
    code: 'PRO',
    name: 'Pro',
    priceMonthly: 35_000,
    priceYearly: 350_000,
    maxRestaurants: 1,
    maxTables: 50,
    maxMembers: 15,
    features: ['online_payments', 'analytics', 'loyalty', 'promotions'],
    position: 1,
  },
  {
    code: 'PREMIUM',
    name: 'Premium',
    priceMonthly: 75_000,
    priceYearly: 750_000,
    maxRestaurants: null,
    maxTables: null,
    maxMembers: null,
    features: [...FEATURES],
    position: 2,
  },
] satisfies {
  code: string;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  maxRestaurants: number | null;
  maxTables: number | null;
  maxMembers: number | null;
  features: Feature[];
  position: number;
}[];
