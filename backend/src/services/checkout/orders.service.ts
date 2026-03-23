import { SavedOrder } from "./checkout.types";

class OrdersService {
  private orders: SavedOrder[] = [];

  save(order: SavedOrder): void {
    this.orders.push(order);
    const label =
      order.items && order.items.length > 1
        ? `${order.items.length} items`
        : order.product?.name ?? "no product";
    console.log(
      `[orders] Saved order for ${order.name} - ${label}`
    );
  }

  getAll(): SavedOrder[] {
    return this.orders;
  }
}

export const ordersService = new OrdersService();
