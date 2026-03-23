import { CheckoutState } from "./checkout.types";

class CheckoutStateService {
  private stateByUser = new Map<string, CheckoutState>();

  get(userId: string): CheckoutState | null {
    return this.stateByUser.get(userId) ?? null;
  }

  set(userId: string, state: CheckoutState): void {
    this.stateByUser.set(userId, state);
  }

  clear(userId: string): void {
    this.stateByUser.delete(userId);
  }

  getAll(): Record<string, CheckoutState> {
    return Object.fromEntries(this.stateByUser.entries());
  }
}

export const checkoutStateService = new CheckoutStateService();
