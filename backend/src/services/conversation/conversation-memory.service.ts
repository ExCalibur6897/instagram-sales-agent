import { IntentName } from "../../modules/ai/ai.types";
import { InventoryItem } from "../inventory/inventory.types";

export type ConversationMemory = {
  lastMentionedProduct: {
    id: string;
    name: string;
  } | null;
  lastListedProducts: Array<{
    id: string;
    name: string;
  }>;
  lastCandidateProducts: Array<{
    id: string;
    name: string;
  }>;
  lastActiveFilters: {
    category: string | null;
    color: string | null;
  };
  lastMentionedCategory: string | null;
  lastMentionedColor: string | null;
  lastIntent: IntentName | null;
  purchaseIntentActive: boolean;
};

class ConversationMemoryService {
  private memoryByUser = new Map<string, ConversationMemory>();

  get(userId: string): ConversationMemory {
    return (
      this.memoryByUser.get(userId) ?? {
        lastMentionedProduct: null,
        lastListedProducts: [],
        lastCandidateProducts: [],
        lastActiveFilters: {
          category: null,
          color: null
        },
        lastMentionedCategory: null,
        lastMentionedColor: null,
        lastIntent: null,
        purchaseIntentActive: false
      }
    );
  }

  remember(userId: string, input: {
    product?: InventoryItem | null;
    listedProducts?: InventoryItem[];
    candidateProducts?: InventoryItem[];
    activeFilters?: {
      category: string | null;
      color: string | null;
    };
    category?: string | null;
    color?: string | null;
    intent?: IntentName | null;
    purchaseIntentActive?: boolean;
  }): void {
    const current = this.get(userId);

    this.memoryByUser.set(userId, {
      lastMentionedProduct:
        input.product === undefined
          ? current.lastMentionedProduct
          : input.product
            ? { id: input.product.id, name: input.product.name }
            : null,
      lastListedProducts:
        input.listedProducts === undefined
          ? current.lastListedProducts
          : input.listedProducts.map((product) => ({
              id: product.id,
              name: product.name
            })),
      lastCandidateProducts:
        input.candidateProducts === undefined
          ? current.lastCandidateProducts
          : input.candidateProducts.map((product) => ({
              id: product.id,
              name: product.name
            })),
      lastActiveFilters:
        input.activeFilters === undefined
          ? current.lastActiveFilters
          : input.activeFilters,
      lastMentionedCategory:
        input.category === undefined
          ? current.lastMentionedCategory
          : input.category,
      lastMentionedColor:
        input.color === undefined ? current.lastMentionedColor : input.color,
      lastIntent:
        input.intent === undefined ? current.lastIntent : input.intent,
      purchaseIntentActive:
        input.purchaseIntentActive === undefined
          ? current.purchaseIntentActive
          : input.purchaseIntentActive
    });
  }

  getAll(): Record<string, ConversationMemory> {
    return Object.fromEntries(this.memoryByUser.entries());
  }
}

export const conversationMemoryService = new ConversationMemoryService();
