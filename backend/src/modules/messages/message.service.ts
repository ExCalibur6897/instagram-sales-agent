import { classifyIntent } from "../ai/classify-intent";
import { extractOrderData } from "../ai/extract-order-data";
import { generateReply } from "../ai/generate-reply";
import { IntentClassification } from "../ai/ai.types";
import { checkoutStateService } from "../../services/checkout/checkout-state.service";
import { ordersService } from "../../services/checkout/orders.service";
import { CheckoutState } from "../../services/checkout/checkout.types";
import {
  conversationMemoryService,
  ConversationMemory
} from "../../services/conversation/conversation-memory.service";
import { inventoryService } from "../../services/inventory/inventory.service";
import { InventoryItem } from "../../services/inventory/inventory.types";
import { openAiClient } from "../../services/openai/openai.client";

type MessageResponse = {
  channel: "instagram";
  userMessage: string;
  intent: string;
  productFound: boolean;
  agentReply: string;
  usedOpenAI: boolean;
  handoff: boolean;
  nextStep?: "collect_order_data";
};

type HandleMessageInput = {
  userId: string;
  message: string;
};

class MessageService {
  async handleIncomingMessage(
    input: HandleMessageInput
  ): Promise<MessageResponse> {
    const pendingState = checkoutStateService.get(input.userId);

    if (pendingState?.nextStep === "collect_order_data") {
      return this.handleOrderDataCollection(input, pendingState);
    }

    const memory = conversationMemoryService.get(input.userId);
    const rawClassification = await classifyIntent(input.message, memory);
    const classification = this.applyConversationContext(
      rawClassification,
      memory
    );

    const searchResult = inventoryService.findMatch(
      this.buildSearchInput(classification)
    );

    const product = this.resolveProductFromContext(classification, searchResult.products);
    const candidateProducts = this.pickCandidateProducts(
      classification,
      searchResult.products,
      product
    );
    const shouldHandoffForBuyingIntent =
      classification.intent === "buying_intent" && Boolean(product);
    const effectiveHandoff =
      shouldHandoffForBuyingIntent || classification.handoff;

    if (
      !product &&
      searchResult.alternatives.length > 0 &&
      !classification.isListRequest &&
      classification.intent !== "collection_request" &&
      classification.intent !== "product_search"
    ) {
      const response = {
        channel: "instagram" as const,
        userMessage: input.message,
        intent: classification.intent,
        productFound: false,
        agentReply: buildClarificationReply(searchResult.alternatives),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };

      this.updateMemory(input.userId, classification, null);
      return response;
    }

    if (classification.intent === "buying_intent" && !product) {
      const response = {
        channel: "instagram" as const,
        userMessage: input.message,
        intent: classification.intent,
        productFound: false,
        agentReply:
          "Claro, te ayudo con la compra. Decime cuál producto te interesa para seguir.",
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };

      this.updateMemory(input.userId, classification, null);
      return response;
    }

    const agentReply = await generateReply({
      userMessage: input.message,
      classification: {
        ...classification,
        handoff: effectiveHandoff
      },
      product,
      products: candidateProducts
    });

    const response: MessageResponse = {
      channel: "instagram",
      userMessage: input.message,
      intent: classification.intent,
      productFound: Boolean(product),
      agentReply,
      usedOpenAI: openAiClient.isConfigured(),
      handoff: effectiveHandoff,
      nextStep: shouldHandoffForBuyingIntent ? "collect_order_data" : undefined
    };

    if (shouldHandoffForBuyingIntent && product) {
      checkoutStateService.set(input.userId, {
        nextStep: "collect_order_data",
        productId: product.id,
        productName: product.name,
        quantity: classification.quantity
      });
    }

    this.updateMemory(
      input.userId,
      classification,
      product ?? (candidateProducts.length === 1 ? candidateProducts[0] : null)
    );

    return response;
  }

  private async handleOrderDataCollection(
    input: HandleMessageInput,
    pendingState: CheckoutState
  ): Promise<MessageResponse> {
    const extractedData = await extractOrderData(input.message);

    if (!extractedData.complete) {
      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: true,
        agentReply: buildMissingDataReply(extractedData),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: true,
        nextStep: "collect_order_data"
      };
    }

    ordersService.save({
      userId: input.userId,
      name: extractedData.name!,
      address: extractedData.address!,
      paymentMethod: extractedData.paymentMethod!,
      quantity: pendingState.quantity ?? null,
      product: {
        id: pendingState.productId,
        name: pendingState.productName
      },
      createdAt: new Date().toISOString()
    });

    checkoutStateService.clear(input.userId);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply:
        "Perfecto, ya tengo tus datos. Alguien del equipo te escribirá en breve para finalizar la compra 🙌",
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true
    };
  }

  private applyConversationContext(
    classification: IntentClassification,
    memory: ConversationMemory
  ): IntentClassification {
    const shouldUsePreviousProduct =
      classification.refersToPreviousProduct ||
      (classification.intent === "buying_intent" &&
        !classification.productName &&
        Boolean(classification.quantity) &&
        Boolean(memory.lastMentionedProduct));

    return {
      ...classification,
      productName:
        !classification.productName && shouldUsePreviousProduct
          ? memory.lastMentionedProduct?.name ?? null
          : classification.productName,
      category:
        classification.category === "ropa" ? null : classification.category,
      color:
        !classification.color && shouldUsePreviousProduct
          ? memory.lastMentionedColor
          : classification.color
    };
  }

  private resolveProductFromContext(
    classification: IntentClassification,
    products: InventoryItem[]
  ): InventoryItem | null {
    if (products.length === 0) {
      return null;
    }

    if (
      classification.intent === "collection_request" ||
      classification.intent === "product_search"
    ) {
      return products.length === 1 ? products[0] : null;
    }

    if (
      !classification.productName &&
      (classification.category || classification.color) &&
      products.length > 1
    ) {
      return null;
    }

    return products[0];
  }

  private buildSearchInput(classification: IntentClassification): {
    productName: string | null;
    category: string | null;
    color: string | null;
  } {
    const shouldIgnoreProductName =
      (classification.isListRequest ||
        classification.intent === "collection_request" ||
        classification.intent === "product_search") &&
      Boolean(classification.category);

    return {
      productName: shouldIgnoreProductName ? null : classification.productName,
      category: classification.category,
      color: classification.color
    };
  }

  private pickCandidateProducts(
    classification: IntentClassification,
    products: InventoryItem[],
    product: InventoryItem | null
  ): InventoryItem[] {
    if (
      classification.isListRequest ||
      classification.intent === "collection_request" ||
      classification.intent === "product_search"
    ) {
      return products.slice(0, 4);
    }

    if (!product && classification.category) {
      return products.slice(0, 4);
    }

    return product ? [product] : [];
  }

  private updateMemory(
    userId: string,
    classification: IntentClassification,
    product: InventoryItem | null
  ): void {
    conversationMemoryService.remember(userId, {
      product: product ?? undefined,
      category: classification.category,
      color: classification.color,
      intent: classification.intent
    });
  }
}

export const messageService = new MessageService();

function buildClarificationReply(alternatives: { name: string }[]): string {
  const names = alternatives.map((item) => item.name).join(", ");
  return `Quiero asegurarme de darte el producto correcto. ¿Te refieres a ${names}?`;
}

function buildMissingDataReply(data: {
  name: string | null;
  address: string | null;
  paymentMethod: string | null;
}): string {
  const missingFields: string[] = [];

  if (!data.name) {
    missingFields.push("tu nombre");
  }

  if (!data.address) {
    missingFields.push("tu dirección de entrega");
  }

  if (!data.paymentMethod) {
    missingFields.push("tu método de pago preferido");
  }

  return `Para seguir con tu compra, compartime ${joinFieldList(missingFields)}.`;
}

function joinFieldList(fields: string[]): string {
  if (fields.length === 1) {
    return fields[0];
  }

  if (fields.length === 2) {
    return `${fields[0]} y ${fields[1]}`;
  }

  return `${fields.slice(0, -1).join(", ")} y ${fields[fields.length - 1]}`;
}
