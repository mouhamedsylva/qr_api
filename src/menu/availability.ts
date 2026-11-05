export interface AvailabilityFields {
  isAvailable: boolean;
  availableAgainAt: Date | null;
  stockQuantity: number | null;
}

/**
 * Disponibilité effective d'un article (MEN-04) :
 * - épuisé manuellement, avec remise automatique à disponible à `availableAgainAt` ;
 * - stock limité : épuisé quand `stockQuantity` atteint 0 (null = illimité).
 * Calculée à la lecture : aucune tâche planifiée n'est nécessaire.
 */
export function isItemAvailable(
  item: AvailabilityFields,
  now: Date = new Date(),
): boolean {
  const manuallyAvailable =
    item.isAvailable ||
    (item.availableAgainAt !== null && item.availableAgainAt <= now);
  const inStock = item.stockQuantity === null || item.stockQuantity > 0;
  return manuallyAvailable && inStock;
}
