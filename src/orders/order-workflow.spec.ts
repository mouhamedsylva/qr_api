import {
  canTransition,
  TERMINAL_STATUSES,
  TRANSITIONS,
} from './order-workflow';

describe('workflow des commandes', () => {
  it('suit le parcours nominal', () => {
    expect(canTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(canTransition('ACCEPTED', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'READY')).toBe(true);
    expect(canTransition('READY', 'SERVED')).toBe(true);
    expect(canTransition('SERVED', 'COMPLETED')).toBe(true);
  });

  it('interdit les retours en arrière et les sauts invalides', () => {
    expect(canTransition('READY', 'PREPARING')).toBe(false);
    expect(canTransition('PENDING', 'READY')).toBe(false);
    expect(canTransition('SERVED', 'CANCELLED')).toBe(false);
  });

  it('seule une commande en attente peut être refusée', () => {
    expect(canTransition('PENDING', 'REJECTED')).toBe(true);
    expect(canTransition('ACCEPTED', 'REJECTED')).toBe(false);
  });

  it("les états terminaux n'ont aucune sortie", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TRANSITIONS[status]).toEqual([]);
    }
  });
});
