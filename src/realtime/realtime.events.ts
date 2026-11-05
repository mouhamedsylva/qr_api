/** Noms des événements temps réel (§9 du cahier des charges). */
export const RealtimeEvents = {
  OrderCreated: 'order.created',
  OrderStatusChanged: 'order.status_changed',
  OrderItemsAdded: 'order.items_added',
  OrderPaymentUpdated: 'order.payment_updated',
  KitchenItemUpdated: 'kitchen.item_updated',
  TableUpdated: 'table.updated',
  MenuItemUpdated: 'menu.item_updated',
} as const;

export type RealtimeEventType =
  (typeof RealtimeEvents)[keyof typeof RealtimeEvents];

export const restaurantRoom = (restaurantId: string) =>
  `restaurant:${restaurantId}`;
export const orderRoom = (orderId: string) => `order:${orderId}`;

/** Message envoyé aux clients : `seq` permet de détecter et rattraper les trous. */
export interface RealtimeMessage<T = unknown> {
  seq: number;
  type: RealtimeEventType;
  restaurantId: string;
  orderId: string | null;
  payload: T;
  createdAt: Date;
}
