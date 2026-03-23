export type InventoryItem = {
  id: string;
  name: string;
  category: string;
  color: string;
  price: number;
  currency: string;
  stock: number;
  description: string;
  keywords?: string[];
};

export type InventoryMatchResult = {
  product: InventoryItem | null;
  alternatives: InventoryItem[];
  products: InventoryItem[];
};

export type InventorySearchInput = {
  productName?: string | null;
  category?: string | null;
  color?: string | null;
};
