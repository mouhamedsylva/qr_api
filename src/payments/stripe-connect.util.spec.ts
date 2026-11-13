import {
  connectAccountParams,
  connectMode,
  isConnectReady,
} from './stripe-connect.util';

const resto = (country: string) => ({
  id: 'r1',
  name: 'Les Délices',
  country,
  email: 'contact@exemple.sn',
});

describe('Stripe Connect selon le pays', () => {
  it('Sénégal : compte destinataire, transferts seulement', () => {
    expect(connectMode('SN')).toBe('recipient');
    const params = connectAccountParams(resto('SN'));
    expect(params).toMatchObject({
      type: 'express',
      country: 'SN',
      tos_acceptance: { service_agreement: 'recipient' },
      capabilities: { transfers: { requested: true } },
    });
    expect(params.capabilities).not.toHaveProperty('card_payments');
  });

  it('France : compte marchand avec paiement par carte', () => {
    expect(connectMode('fr')).toBe('merchant');
    const params = connectAccountParams(resto('FR'));
    expect(params.capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
    expect(params).not.toHaveProperty('tos_acceptance');
  });

  it('considère le compte prêt dès que les transferts ou les encaissements sont actifs', () => {
    expect(
      isConnectReady({
        charges_enabled: false,
        capabilities: { transfers: 'active' },
      }),
    ).toBe(true);
    expect(isConnectReady({ charges_enabled: true, capabilities: {} })).toBe(
      true,
    );
    expect(
      isConnectReady({
        charges_enabled: false,
        capabilities: { transfers: 'pending' },
      }),
    ).toBe(false);
  });
});
