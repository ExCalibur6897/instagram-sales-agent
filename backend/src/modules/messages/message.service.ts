import { IntentClassification } from "../ai/ai.types";
import { classifyIntent } from "../ai/classify-intent";
import { extractOrderData } from "../ai/extract-order-data";
import { buildFaqReply } from "../ai/faq-reply";
import { generateReply } from "../ai/generate-reply";
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
    const memory = conversationMemoryService.get(input.userId);
    const rawClassification = await classifyIntent(input.message, memory);
    const classification = this.enrichClassificationFromMessage(
      this.applyConversationContext(rawClassification, memory),
      input.message
    );
    const purchaseIntentActive = this.resolvePurchaseIntentActive(
      input.message,
      classification,
      memory
    );

    if (
      pendingState?.nextStep === "collect_order_data" &&
      isCheckoutCancellationMessage(input.message)
    ) {
      return this.buildCheckoutCancellationResponse(input.userId, input.message);
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      looksLikeOrderDataMessage(input.message)
    ) {
      return this.handleOrderDataCollection(input, pendingState);
    }

    if (classification.intent === "greeting") {
      return this.buildGreetingResponse(input.message, classification, input.userId);
    }

    if (this.isFaqIntent(classification)) {
      return this.buildFaqResponse(input.message, classification, input.userId);
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.shouldHandleAsOrderData(classification, input.message)
    ) {
      return this.handleOrderDataCollection(input, pendingState);
    }

    const listedContextResult = this.resolveFromListedContext(
      classification,
      memory
    );
    const searchResult =
      listedContextResult ??
      inventoryService.findMatch(this.buildSearchInput(classification));
    const resolvedFromFilteredContext = Boolean(listedContextResult);
    const product = this.resolveProductFromContext(
      classification,
      searchResult.products,
      memory,
      purchaseIntentActive,
      input.message
    );
    const candidateProducts = this.pickCandidateProducts(
      classification,
      searchResult.products,
      product,
      resolvedFromFilteredContext
    );
    const effectiveIntent = this.resolveEffectiveIntent(
      classification,
      product,
      purchaseIntentActive
    );
    const shouldHandoffForBuyingIntent =
      effectiveIntent === "buying_intent" && Boolean(product);
    const effectiveHandoff =
      shouldHandoffForBuyingIntent || classification.handoff;

    if (
      !product &&
      candidateProducts.length === 0 &&
      classification.category &&
      classification.color &&
      searchResult.availableColors.length > 0
    ) {
      const response = {
        channel: "instagram" as const,
        userMessage: input.message,
        intent: effectiveIntent,
        productFound: false,
        agentReply: buildUnavailableColorReply(
          classification.category,
          classification.color,
          searchResult.availableColors
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };

      this.updateMemory(input.userId, classification, null);
      return response;
    }

    if (
      !product &&
      searchResult.alternatives.length > 0 &&
      !classification.isListRequest &&
      classification.intent !== "collection_request" &&
      classification.intent !== "product_search" &&
      classification.intent !== "product_availability"
    ) {
      const response = {
        channel: "instagram" as const,
        userMessage: input.message,
        intent: effectiveIntent,
        productFound: false,
        agentReply: buildClarificationReply(searchResult.alternatives),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };

      this.updateMemory(input.userId, classification, null, {
        listedProducts: [],
        candidateProducts: searchResult.alternatives,
        activeFilters: {
          category: classification.category,
          color: classification.color
        },
        purchaseIntentActive
      });
      return response;
    }

    if (effectiveIntent === "buying_intent" && !product) {
      const response = {
        channel: "instagram" as const,
        userMessage: input.message,
        intent: effectiveIntent,
        productFound: false,
        agentReply: buildBuyingClarificationReply(classification),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };

      this.updateMemory(input.userId, classification, null, {
        listedProducts: [],
        candidateProducts: this.getCandidateProductsForPurchaseClarification(
          classification,
          searchResult.products,
          memory
        ),
        activeFilters: {
          category: classification.category,
          color: classification.color
        },
        purchaseIntentActive: true
      });
      return response;
    }

    const agentReply = await generateReply({
      userMessage: input.message,
      classification: {
        ...classification,
        intent: effectiveIntent,
        handoff: effectiveHandoff
      },
      product,
      products: candidateProducts
    });

    const response: MessageResponse = {
      channel: "instagram",
      userMessage: input.message,
      intent: effectiveIntent,
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
      {
        ...classification,
        intent: effectiveIntent
      },
      product ?? (candidateProducts.length === 1 ? candidateProducts[0] : null),
      {
        listedProducts:
          candidateProducts.length > 0 &&
          (classification.intent === "collection_request" ||
            classification.intent === "product_search" ||
            classification.intent === "product_availability")
            ? candidateProducts
            : [],
        candidateProducts,
        activeFilters: {
          category: classification.category,
          color: classification.color
        },
        purchaseIntentActive
      }
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
    conversationMemoryService.remember(input.userId, {
      purchaseIntentActive: false,
      candidateProducts: [],
      product: null
    });

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
      (classification.refersToPreviousProduct &&
        !classification.productName &&
        !classification.category) ||
      (classification.intent === "buying_intent" &&
        !classification.productName &&
        !classification.category &&
        !classification.color &&
        Boolean(classification.quantity) &&
        Boolean(memory.lastMentionedProduct));

    return {
      ...classification,
      productName: shouldUsePreviousProduct
        ? memory.lastMentionedProduct?.name ?? null
        : classification.productName,
      category:
        classification.category === "ropa" ? null : classification.category,
      color:
        shouldUsePreviousProduct && !classification.color
          ? memory.lastMentionedColor
          : classification.color
    };
  }

  private enrichClassificationFromMessage(
    classification: IntentClassification,
    message: string
  ): IntentClassification {
    const inferredCategory = inferCategoryFromMessage(message);
    const inferredColor = inferColorFromMessage(message);
    const normalizedCategory =
      normalizeCategoryLabel(classification.category) ?? inferredCategory;
    const normalizedColor =
      inferredColor ??
      (classification.refersToPreviousProduct
        ? normalizeColorLabel(classification.color)
        : null);

    return {
      ...classification,
      category: normalizedCategory,
      color: normalizedColor
    };
  }

  private resolveProductFromContext(
    classification: IntentClassification,
    products: InventoryItem[],
    memory: ConversationMemory,
    purchaseIntentActive: boolean,
    message: string
  ): InventoryItem | null {
    const lastCandidateProducts = this.getLastCandidateProducts(memory);

    if (
      purchaseIntentActive &&
      isCandidateSelectionReference(message) &&
      !classification.productName &&
      !classification.category &&
      !classification.color
    ) {
      return lastCandidateProducts.length === 1 ? lastCandidateProducts[0] : null;
    }

    if (products.length === 0) {
      return null;
    }

    if (
      classification.intent === "collection_request" ||
      classification.intent === "product_search"
    ) {
      if (purchaseIntentActive && this.hasExplicitSelection(classification)) {
        return products.length === 1 ? products[0] : null;
      }

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
    product: InventoryItem | null,
    resolvedFromFilteredContext: boolean
  ): InventoryItem[] {
    if (resolvedFromFilteredContext && product) {
      return [product];
    }

    if (
      classification.isListRequest ||
      classification.intent === "collection_request" ||
      classification.intent === "product_search" ||
      classification.intent === "product_availability"
    ) {
      return products.slice(0, 4);
    }

    return product ? [product] : [];
  }

  private updateMemory(
    userId: string,
    classification: IntentClassification,
    product: InventoryItem | null,
    options?: {
      listedProducts?: InventoryItem[];
      candidateProducts?: InventoryItem[];
      activeFilters?: {
        category: string | null;
        color: string | null;
      };
      purchaseIntentActive?: boolean;
    }
  ): void {
    conversationMemoryService.remember(userId, {
      product,
      listedProducts: options?.listedProducts,
      candidateProducts: options?.candidateProducts,
      activeFilters: options?.activeFilters,
      category: classification.category,
      color: classification.color,
      intent: classification.intent,
      purchaseIntentActive: options?.purchaseIntentActive
    });
  }

  private resolvePurchaseIntentActive(
    message: string,
    classification: IntentClassification,
    memory: ConversationMemory
  ): boolean {
    if (classification.intent === "buying_intent") {
      return true;
    }

    if (looksLikePurchaseIntentMessage(message)) {
      return true;
    }

    return memory.purchaseIntentActive;
  }

  private resolveEffectiveIntent(
    classification: IntentClassification,
    product: InventoryItem | null,
    purchaseIntentActive: boolean
  ): IntentClassification["intent"] {
    if (
      purchaseIntentActive &&
      product &&
      this.hasExplicitSelection(classification)
    ) {
      return "buying_intent";
    }

    return classification.intent;
  }

  private hasExplicitSelection(classification: IntentClassification): boolean {
    return Boolean(
      classification.productName ||
        (classification.category && classification.color)
    );
  }

  private getLastCandidateProducts(memory: ConversationMemory): InventoryItem[] {
    return memory.lastCandidateProducts
      .map((product) => inventoryService.findById(product.id))
      .filter((product): product is InventoryItem => Boolean(product));
  }

  private getLastListedProducts(memory: ConversationMemory): InventoryItem[] {
    return memory.lastListedProducts
      .map((product) => inventoryService.findById(product.id))
      .filter((product): product is InventoryItem => Boolean(product));
  }

  private resolveFromListedContext(
    classification: IntentClassification,
    memory: ConversationMemory
  ) {
    const lastListedProducts = this.getLastListedProducts(memory);

    if (
      lastListedProducts.length === 0 ||
      (!classification.category &&
        !classification.color &&
        !classification.productName &&
        !classification.refersToPreviousProduct)
    ) {
      return null;
    }

    const scopedResult = inventoryService.findMatchInItems(
      lastListedProducts,
      this.buildSearchInput(classification)
    );

    if (
      scopedResult.products.length === 0 &&
      scopedResult.availableColors.length === 0
    ) {
      return null;
    }

    return scopedResult;
  }

  private getCandidateProductsForPurchaseClarification(
    classification: IntentClassification,
    products: InventoryItem[],
    memory: ConversationMemory
  ): InventoryItem[] {
    if (products.length > 0) {
      return products.slice(0, 4);
    }

    if (
      classification.quantity &&
      !classification.productName &&
      !classification.category &&
      !classification.color
    ) {
      return this.getLastCandidateProducts(memory).slice(0, 4);
    }

    return [];
  }

  private isFaqIntent(classification: IntentClassification): boolean {
    return [
      "faq_location",
      "faq_hours",
      "faq_payment",
      "faq_shipping"
    ].includes(classification.intent);
  }

  private shouldHandleAsOrderData(
    classification: IntentClassification,
    message: string
  ): boolean {
    if (this.isFaqIntent(classification)) {
      return false;
    }

    if (
      classification.intent === "product_search" ||
      classification.intent === "collection_request" ||
      classification.intent === "price_question" ||
      classification.intent === "product_availability" ||
      classification.intent === "greeting"
    ) {
      return false;
    }

    if (classification.intent === "buying_intent") {
      return false;
    }

    return looksLikeOrderDataMessage(message);
  }

  private buildFaqResponse(
    message: string,
    classification: IntentClassification,
    userId: string
  ): MessageResponse {
    conversationMemoryService.remember(userId, {
      intent: classification.intent
    });

    return {
      channel: "instagram",
      userMessage: message,
      intent: classification.intent,
      productFound: false,
      agentReply: buildFaqReply(classification),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: false
    };
  }

  private buildGreetingResponse(
    message: string,
    classification: IntentClassification,
    userId: string
  ): MessageResponse {
    conversationMemoryService.remember(userId, {
      intent: classification.intent
    });

    return {
      channel: "instagram",
      userMessage: message,
      intent: classification.intent,
      productFound: false,
      agentReply: buildGreetingReply(message, classification.tone),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: false
    };
  }

  private buildCheckoutCancellationResponse(
    userId: string,
    message: string
  ): MessageResponse {
    checkoutStateService.clear(userId);
    conversationMemoryService.remember(userId, {
      purchaseIntentActive: false,
      candidateProducts: []
    });

    return {
      channel: "instagram",
      userMessage: message,
      intent: "buying_intent",
      productFound: false,
      agentReply: buildCheckoutCancellationReply(message),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: false
    };
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

function buildBuyingClarificationReply(
  classification: IntentClassification
): string {
  if (classification.quantity) {
    return "Claro, te ayudo con la compra. Decime qué producto quieres llevar para aplicar esa cantidad.";
  }

  return "Claro, te ayudo con la compra. Decime cuál producto te interesa para seguir.";
}

function looksLikeOrderDataMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const hasCommaSeparatedData = message.split(",").filter(Boolean).length >= 2;
  const mentionsPayment =
    normalized.includes("transfer") ||
    normalized.includes("tarjeta") ||
    normalized.includes("efectivo");

  return hasCommaSeparatedData || mentionsPayment;
}

function inferCategoryFromMessage(message: string): string | null {
  const normalized = message.toLowerCase();
  const categoryAliases: Record<string, string> = {
    hoodie: "hoodie",
    hoodies: "hoodie",
    hudi: "hoodie",
    jogger: "jogger",
    joggers: "jogger",
    yugers: "jogger",
    camiseta: "camiseta",
    camisetas: "camiseta",
    gorra: "gorra",
    gorras: "gorra",
    polo: "polo",
    polos: "polo",
    short: "short",
    shorts: "short",
    pantaloneta: "short",
    pantalonetas: "short"
  };

  return (
    Object.entries(categoryAliases).find(([alias]) => normalized.includes(alias))?.[1] ??
    null
  );
}

function inferColorFromMessage(message: string): string | null {
  const normalized = message.toLowerCase();
  const colorAliases: Record<string, string> = {
    negro: "negro",
    negra: "negro",
    blanco: "blanco",
    blanca: "blanco",
    gris: "gris",
    beige: "beige",
    rojo: "rojo",
    roja: "rojo",
    azul: "azul",
    denim: "denim"
  };

  return (
    Object.entries(colorAliases).find(([alias]) => normalized.includes(alias))?.[1] ??
    null
  );
}

function normalizeCategoryLabel(category: string | null): string | null {
  if (!category) {
    return null;
  }

  const aliases: Record<string, string> = {
    hoodie: "hoodie",
    hoodies: "hoodie",
    hudi: "hoodie",
    jogger: "jogger",
    joggers: "jogger",
    yugers: "jogger",
    camiseta: "camiseta",
    camisetas: "camiseta",
    gorra: "gorra",
    gorras: "gorra",
    polo: "polo",
    polos: "polo",
    short: "short",
    shorts: "short",
    pantaloneta: "short",
    pantalonetas: "short"
  };

  return aliases[category.toLowerCase()] ?? category.toLowerCase();
}

function normalizeColorLabel(color: string | null): string | null {
  if (!color) {
    return null;
  }

  const aliases: Record<string, string> = {
    negro: "negro",
    negra: "negro",
    blanco: "blanco",
    blanca: "blanco",
    rojo: "rojo",
    roja: "rojo"
  };

  return aliases[color.toLowerCase()] ?? color.toLowerCase();
}

function buildUnavailableColorReply(
  category: string,
  color: string,
  availableColors: string[]
): string {
  const categoryLabel = pluralizeCategory(category);
  const requestedColor = normalizeDisplayColor(color);
  const colorsLabel = availableColors.map(normalizeDisplayColor).join(", ");

  return `No tenemos ${categoryLabel} en ${requestedColor}, pero tenemos estos colores disponibles: ${colorsLabel}.`;
}

function pluralizeCategory(category: string): string {
  if (category.endsWith("s")) {
    return category;
  }

  return `${category}s`;
}

function normalizeDisplayColor(color: string): string {
  if (color === "negro") {
    return "negro";
  }

  if (color === "blanco") {
    return "blanco";
  }

  return color;
}

function buildGreetingReply(message: string, tone: string): string {
  const normalized = message.toLowerCase();
  const isCasual =
    tone === "casual" ||
    normalized.includes("bro") ||
    normalized.includes("man") ||
    normalized.includes("q ondas") ||
    normalized.includes("qué ondas");

  if (isCasual) {
    return "¡Buenas! Decime qué producto andás buscando y te ayudo.";
  }

  if (normalized.includes("buenas")) {
    return "¡Buenas! Si quieres, te puedo ayudar con productos, precios o disponibilidad.";
  }

  return "¡Hola! 👋 ¿En qué te puedo ayudar hoy?";
}

function looksLikePurchaseIntentMessage(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("quiero comprar") ||
    normalized.includes("me interesa comprar") ||
    normalized.includes("quiero uno") ||
    normalized.includes("quiero dos")
  );
}

function isCandidateSelectionReference(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("uno") ||
    normalized.includes("dos") ||
    normalized.includes("esa") ||
    normalized.includes("ese")
  );
}

function isCheckoutCancellationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const cancellationPhrases = [
    "ya no",
    "ya no man",
    "mejor no",
    "olvidalo",
    "olvídalo",
    "cancela",
    "cancelá",
    "ya no quiero",
    "despues",
    "después",
    "ahorita no",
    "nel",
    "nada que ver"
  ];

  return cancellationPhrases.some((phrase) => normalized.includes(phrase));
}

function buildCheckoutCancellationReply(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("despues") || normalized.includes("después")) {
    return "Está bien 🙌 Si después quieres retomarlo o ver otro producto, aquí estoy.";
  }

  if (normalized.includes("man") || normalized.includes("nel")) {
    return "Dale, sin problema. Si quieres ver otro producto o retomar la compra después, aquí estoy.";
  }

  return "No hay problema. Si luego quieres seguir con la compra o ver otras opciones, te ayudo.";
}
