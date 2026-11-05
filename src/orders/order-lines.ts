import { BadRequestException, ConflictException } from '@nestjs/common';
import { isItemAvailable } from '../menu/availability';
import type { OrderLineDto } from './dto/orders.dto';

export interface MenuOption {
  id: string;
  name: string;
  priceDelta: number;
  isAvailable: boolean;
}

export interface MenuOptionGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: MenuOption[];
}

export interface OrderableMenuItem {
  id: string;
  name: string;
  priceAmount: number;
  prepTimeMinutes: number | null;
  isAvailable: boolean;
  availableAgainAt: Date | null;
  stockQuantity: number | null;
  optionGroups: MenuOptionGroup[];
  /** Poste de préparation résolu (article, sinon catégorie) — KDS-02. */
  stationId?: string | null;
}

export interface OptionSnapshot {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  priceDelta: number;
}

export interface BuiltLine {
  menuItemId: string;
  name: string;
  unitPrice: number;
  /** Prix de base de l’article, hors options. */
  basePrice: number;
  stationId: string | null;
  quantity: number;
  options: OptionSnapshot[];
  notes?: string;
  lineTotal: number;
  prepTimeMinutes: number | null;
}

/**
 * Transforme le panier en lignes de commande (CMD-05) en s'appuyant
 * uniquement sur les prix du serveur : le client ne fournit que des ids.
 * Vérifie disponibilité, stock et règles des groupes d'options (MEN-03).
 */
export function buildOrderLines(
  lines: OrderLineDto[],
  menuItems: Map<string, OrderableMenuItem>,
  now: Date = new Date(),
): { lines: BuiltLine[]; stockNeeded: Map<string, number> } {
  const stockNeeded = new Map<string, number>();

  const built = lines.map((line) => {
    const item = menuItems.get(line.menuItemId);
    if (!item) {
      throw new BadRequestException({
        code: 'ITEM_NOT_FOUND',
        message: 'Un article du panier n’existe plus',
        details: { menuItemId: line.menuItemId },
      });
    }
    if (!isItemAvailable(item, now)) {
      throw new ConflictException({
        code: 'ITEM_UNAVAILABLE',
        message: `« ${item.name} » est épuisé`,
        details: { menuItemId: item.id },
      });
    }

    const selected = new Set(line.optionIds ?? []);
    const options: OptionSnapshot[] = [];
    for (const group of item.optionGroups) {
      const chosen = group.options.filter((o) => selected.has(o.id));
      if (chosen.length < group.minSelect || chosen.length > group.maxSelect) {
        throw new BadRequestException({
          code: 'INVALID_OPTIONS',
          message: `« ${item.name} » : choisissez entre ${group.minSelect} et ${group.maxSelect} option(s) pour « ${group.name} »`,
          details: { menuItemId: item.id, groupId: group.id },
        });
      }
      for (const option of chosen) {
        if (!option.isAvailable) {
          throw new ConflictException({
            code: 'OPTION_UNAVAILABLE',
            message: `L’option « ${option.name} » est indisponible`,
            details: { optionId: option.id },
          });
        }
        selected.delete(option.id);
        options.push({
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          name: option.name,
          priceDelta: option.priceDelta,
        });
      }
    }
    if (selected.size) {
      throw new BadRequestException({
        code: 'INVALID_OPTIONS',
        message: `Options inconnues pour « ${item.name} »`,
        details: { optionIds: [...selected] },
      });
    }

    if (item.stockQuantity !== null) {
      stockNeeded.set(item.id, (stockNeeded.get(item.id) ?? 0) + line.quantity);
    }

    const unitPrice =
      item.priceAmount + options.reduce((sum, o) => sum + o.priceDelta, 0);
    return {
      menuItemId: item.id,
      name: item.name,
      unitPrice,
      quantity: line.quantity,
      options,
      notes: line.notes,
      basePrice: item.priceAmount,
      stationId: item.stationId ?? null,
      lineTotal: unitPrice * line.quantity,
      prepTimeMinutes: item.prepTimeMinutes,
    };
  });

  for (const [id, qty] of stockNeeded) {
    const stock = menuItems.get(id)?.stockQuantity ?? 0;
    if (qty > stock) {
      throw new ConflictException({
        code: 'OUT_OF_STOCK',
        message: `Stock insuffisant pour « ${menuItems.get(id)?.name} »`,
        details: { menuItemId: id, available: stock },
      });
    }
  }

  return { lines: built, stockNeeded };
}
