import { IntentName } from "../../modules/ai/ai.types";
import { InventoryItem } from "../inventory/inventory.types";

export type ConversationMemory = {
  lastMentionedProduct: {
    id: string;
    name: string;
  } | null;
  lastMentionedCategory: string | null;
  lastMentionedColor: string | null;
  lastIntent: IntentName | null;
};

class ConversationMemoryService {
  private memoryByUser = new Map<string, ConversationMemory>();

  get(userId: string): ConversationMemory {
    return (
      this.memoryByUser.get(userId) ?? {
        lastMentionedProduct: null,
        lastMentionedCategory: null,
        lastMentionedColor: null,
        lastIntent: null
      }
    );
  }

  remember(userId: string, input: {
    product?: InventoryItem | null;
    category?: string | null;
    color?: string | null;
    intent?: IntentName | null;
  }): void {
    const current = this.get(userId);

    this.memoryByUser.set(userId, {
      lastMentionedProduct:
        input.product === undefined
          ? current.lastMentionedProduct
          : input.product
            ? { id: input.product.id, name: input.product.name }
            : null,
      lastMentionedCategory:
        input.category === undefined
          ? current.lastMentionedCategory
          : input.category,
      lastMentionedColor:
        input.color === undefined ? current.lastMentionedColor : input.color,
      lastIntent:
        input.intent === undefined ? current.lastIntent : input.intent
    });
  }

  getAll(): Record<string, ConversationMemory> {
    return Object.fromEntries(this.memoryByUser.entries());
  }
}

export const conversationMemoryService = new ConversationMemoryService();
