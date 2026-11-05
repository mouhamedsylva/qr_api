import { isItemAvailable } from './availability';

describe('isItemAvailable', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const base = {
    isAvailable: true,
    availableAgainAt: null,
    stockQuantity: null,
  };

  it('disponible par défaut', () => {
    expect(isItemAvailable(base, now)).toBe(true);
  });

  it('épuisé manuellement sans date de retour', () => {
    expect(isItemAvailable({ ...base, isAvailable: false }, now)).toBe(false);
  });

  it('redevient disponible à la date prévue', () => {
    const item = {
      ...base,
      isAvailable: false,
      availableAgainAt: new Date('2026-11-02T11:00:00Z'),
    };
    expect(isItemAvailable(item, now)).toBe(true);
    expect(isItemAvailable(item, new Date('2026-11-02T10:00:00Z'))).toBe(false);
  });

  it('épuisé quand le stock limité atteint 0', () => {
    expect(isItemAvailable({ ...base, stockQuantity: 0 }, now)).toBe(false);
    expect(isItemAvailable({ ...base, stockQuantity: 3 }, now)).toBe(true);
  });
});
