import {
  canMoveItem,
  compareTickets,
  computeUrgency,
  deriveOrderStatus,
} from './kitchen.rules';

describe('règles de la cuisine', () => {
  it('encadre les transitions d’une ligne', () => {
    expect(canMoveItem('PENDING', 'IN_PROGRESS')).toBe(true);
    expect(canMoveItem('PENDING', 'READY')).toBe(true);
    expect(canMoveItem('READY', 'IN_PROGRESS')).toBe(true);
    expect(canMoveItem('IN_PROGRESS', 'PENDING')).toBe(false);
    expect(canMoveItem('READY', 'PENDING')).toBe(false);
  });

  it('déduit le statut de la commande de l’avancement des lignes', () => {
    expect(deriveOrderStatus('ACCEPTED', ['PENDING', 'PENDING'])).toBeNull();
    expect(deriveOrderStatus('ACCEPTED', ['IN_PROGRESS', 'PENDING'])).toBe(
      'PREPARING',
    );
    expect(deriveOrderStatus('PREPARING', ['READY', 'IN_PROGRESS'])).toBeNull();
    expect(deriveOrderStatus('PREPARING', ['READY', 'READY'])).toBe('READY');
    expect(deriveOrderStatus('ACCEPTED', ['READY'])).toBe('READY');
    // Hors cuisine (en attente, servie…) : jamais de changement automatique.
    expect(deriveOrderStatus('PENDING', ['READY'])).toBeNull();
    expect(deriveOrderStatus('SERVED', ['READY'])).toBeNull();
  });

  it('calcule l’urgence selon le délai estimé', () => {
    const created = new Date('2026-11-05T12:00:00Z');
    const eta = new Date('2026-11-05T12:20:00Z');
    expect(computeUrgency(created, eta, new Date('2026-11-05T12:05:00Z'))).toBe(
      'normal',
    );
    expect(computeUrgency(created, eta, new Date('2026-11-05T12:16:00Z'))).toBe(
      'warning',
    );
    expect(computeUrgency(created, eta, new Date('2026-11-05T12:20:00Z'))).toBe(
      'late',
    );
    expect(computeUrgency(created, null)).toBe('normal');
  });

  it('trie : prioritaires, en retard, puis plus anciens', () => {
    const t = (
      id: string,
      isRush: boolean,
      urgency: 'normal' | 'warning' | 'late',
      minute: number,
    ) => ({
      id,
      isRush,
      urgency,
      createdAt: new Date(
        `2026-11-05T12:${String(minute).padStart(2, '0')}:00Z`,
      ),
    });
    const sorted = [
      t('recent', false, 'normal', 30),
      t('ancien', false, 'normal', 10),
      t('retard', false, 'late', 20),
      t('urgent', true, 'normal', 40),
    ].sort(compareTickets);
    expect(sorted.map((x) => x.id)).toEqual([
      'urgent',
      'retard',
      'ancien',
      'recent',
    ]);
  });
});
