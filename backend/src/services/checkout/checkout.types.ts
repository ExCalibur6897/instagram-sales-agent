export type CheckoutStep = "collect_order_data" | "clarify_cart_items";

export type CheckoutCartItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  subtotal: number;
};

export type PendingCartItem = {
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number;
  keywords: string[];
};

export type CheckoutState = {
  nextStep: CheckoutStep;
  productId?: string;
  productName?: string;
  quantity?: number | null;
  items?: CheckoutCartItem[];
  pendingItems?: PendingCartItem[];
};

export type SavedOrder = {
  userId: string;
  name: string;
  address: string;
  paymentMethod: string;
  quantity?: number | null;
  items?: CheckoutCartItem[];
  subtotal?: number;
  product: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
};
