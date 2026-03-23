import { SavedOrder } from "./checkout.types";

class OrdersService {
  private orders: SavedOrder[] = [];

  save(order: SavedOrder): void {
    this.orders.push(order);
    console.log(
      `[orders] Saved order for ${order.name} - ${order.product?.name ?? "no product"}`
    );
  }

  getAll(): SavedOrder[] {
    return this.orders;
  }
}

export const ordersService = new OrdersService();
