export type CheckoutStep = "collect_order_data";

export type CheckoutState = {
  nextStep: CheckoutStep;
  productId: string;
  productName: string;
  quantity?: number | null;
};

export type SavedOrder = {
  userId: string;
  name: string;
  address: string;
  paymentMethod: string;
  quantity?: number | null;
  product: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
};
