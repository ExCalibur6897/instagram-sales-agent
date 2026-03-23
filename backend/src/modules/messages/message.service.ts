import { IntentClassification, IntentName } from "../ai/ai.types";
import { classifyIntent } from "../ai/classify-intent";
import { extractMessageIntents } from "../ai/extract-message-intents";
import { extractOrderData } from "../ai/extract-order-data";
import {
  CartOperation,
  extractCartOperations
} from "../ai/extract-cart-operations";
import {
  extractPurchaseItems,
  PurchaseItemInput
} from "../ai/extract-purchase-items";
import { buildFaqReply } from "../ai/faq-reply";
import { generateReply } from "../ai/generate-reply";
import { checkoutStateService } from "../../services/checkout/checkout-state.service";
import { ordersService } from "../../services/checkout/orders.service";
import {
  CheckoutCartItem,
  CheckoutState,
  PendingCartItem
} from "../../services/checkout/checkout.types";
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

type ResolvedPurchaseItem = {
  requestedItem: PendingCartItem;
  cartItem: CheckoutCartItem;
};

type PurchaseResolution = {
  resolvedItems: ResolvedPurchaseItem[];
  pendingItems: PendingCartItem[];
};

class MessageService {
  async handleIncomingMessage(
    input: HandleMessageInput
  ): Promise<MessageResponse> {
    const pendingState = checkoutStateService.get(input.userId);
    const memory = conversationMemoryService.get(input.userId);
    const rawClassification = await classifyIntent(input.message, memory);
    const extractedIntents = prioritizeDetectedIntents(
      this.enrichDetectedIntents(
        await extractMessageIntents(input.message, memory),
        rawClassification,
        input.message
      )
    );
    const classification = this.applyPrimaryIntent(
      this.enrichClassificationFromMessage(
      this.applyConversationContext(rawClassification, memory),
      input.message
      ),
      extractedIntents
    );
    const purchaseIntentActive = this.resolvePurchaseIntentActive(
      input.message,
      classification,
      memory
    );
    const purchaseMessage = stripSecondaryProductClause(input.message);
    const requestedItems = await extractPurchaseItems(purchaseMessage);
    const cartOperations =
      pendingState &&
      (this.hasActiveCartItems(pendingState) ||
        (pendingState.pendingItems ?? []).length > 0)
        ? await extractCartOperations(input.message)
        : [];

    if (
      pendingState &&
      cartOperations.length === 0 &&
      isCheckoutCancellationMessage(input.message)
    ) {
      return this.buildCheckoutCancellationResponse(input.userId, input.message);
    }

    if (pendingState && looksLikeResumePurchaseMessage(input.message)) {
      return this.buildPendingCartResponse(input, pendingState);
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      looksLikeOrderDataMessage(input.message)
    ) {
      return this.handleOrderDataCollection(input, pendingState);
    }

    if (classification.intent === "greeting") {
      return this.buildGreetingResponse(
        input.message,
        classification,
        input.userId,
        extractedIntents
      );
    }

    if (this.isFaqIntent(classification)) {
      return this.buildFaqResponse(
        input.message,
        classification,
        input.userId,
        Boolean(pendingState) || purchaseIntentActive,
        extractedIntents
      );
    }

    if (pendingState?.nextStep === "clarify_cart_items") {
      if (cartOperations.length > 0) {
        return this.handlePendingCartOperations(
          input,
          pendingState,
          cartOperations,
          classification,
          extractedIntents,
          memory
        );
      }

      return this.handlePendingCartClarification(
        input,
        pendingState,
        classification
      );
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.shouldHandleAsOrderData(classification, input.message)
    ) {
      return this.handleOrderDataCollection(input, pendingState);
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.hasActiveCartItems(pendingState) &&
      this.shouldReduceSingleCartItem(pendingState, input.message, classification)
    ) {
      return this.handleSingleCartItemReduction(
        input,
        pendingState,
        classification,
        extractedIntents
      );
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.hasActiveCartItems(pendingState) &&
      cartOperations.length > 0
    ) {
      return this.handleActiveCartOperations(
        input,
        pendingState,
        cartOperations,
        classification,
        extractedIntents,
        memory
      );
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.hasActiveCartItems(pendingState) &&
      this.shouldAppendToActiveCart(input.message, classification, requestedItems)
    ) {
      return this.handleActiveCartUpdate(
        input,
        pendingState,
        classification,
        requestedItems,
        extractedIntents
      );
    }

    if (
      pendingState?.nextStep === "collect_order_data" &&
      this.hasActiveCartItems(pendingState) &&
      this.looksLikeCartReferenceMessage(input.message, classification)
    ) {
      return this.handleActiveCartReference(
        input,
        pendingState,
        classification,
        extractedIntents,
        memory
      );
    }

    if (classification.intent === "buying_intent" && requestedItems.length > 1) {
      return this.handleMultiItemPurchase(
        input,
        classification,
        requestedItems,
        purchaseIntentActive,
        extractedIntents
      );
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
    const decoratedAgentReply = this.decorateReplyWithSecondaryIntents(
      agentReply,
      {
        ...classification,
        intent: effectiveIntent
      },
      extractedIntents,
      Boolean(pendingState) || effectiveHandoff,
      input.message
    );

    const response: MessageResponse = {
      channel: "instagram",
      userMessage: input.message,
      intent: effectiveIntent,
      productFound: Boolean(product),
      agentReply: decoratedAgentReply,
      usedOpenAI: openAiClient.isConfigured(),
      handoff: effectiveHandoff,
      nextStep: shouldHandoffForBuyingIntent ? "collect_order_data" : undefined
    };

    if (shouldHandoffForBuyingIntent && product) {
      this.persistCheckoutCart(input.userId, [
        {
          productId: product.id,
          productName: product.name,
          quantity: classification.quantity ?? 1,
          unitPrice: product.price,
          currency: product.currency,
          subtotal: product.price * (classification.quantity ?? 1)
        }
      ]);
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
      items: pendingState.items ?? [],
      subtotal: calculateCartSubtotal(pendingState.items ?? []),
      product: {
        id: pendingState.productId ?? pendingState.items?.[0]?.productId ?? "",
        name: pendingState.productName ?? pendingState.items?.[0]?.productName ?? ""
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
        "Perfecto, ya tengo tus datos. Alguien del equipo te escribir\u00e1 en breve para finalizar la compra \ud83d\ude4c",
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true
    };
  }

  private async handleMultiItemPurchase(
    input: HandleMessageInput,
    classification: IntentClassification,
    requestedItems: PurchaseItemInput[],
    purchaseIntentActive: boolean,
    extractedIntents: IntentName[]
  ): Promise<MessageResponse> {
    const resolution = this.resolvePurchaseItems(requestedItems);

    if (resolution.pendingItems.length > 0) {
      checkoutStateService.set(input.userId, {
        nextStep: "clarify_cart_items",
        items: resolution.resolvedItems.map((item) => item.cartItem),
        pendingItems: resolution.pendingItems
      });

      const firstResolvedProduct =
        resolution.resolvedItems.length > 0
          ? inventoryService.findById(resolution.resolvedItems[0].cartItem.productId)
          : null;

      this.updateMemory(input.userId, classification, firstResolvedProduct, {
        candidateProducts: [],
        purchaseIntentActive: true
      });

      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: resolution.resolvedItems.length > 0,
        agentReply: buildPartialCartClarificationReply(
          resolution.resolvedItems.map((item) => item.cartItem),
          resolution.pendingItems[0]
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    const cartItems = resolution.resolvedItems.map((item) => item.cartItem);
    this.persistCheckoutCart(input.userId, cartItems);
    this.updateMemory(
      input.userId,
      classification,
      inventoryService.findById(cartItems[0]?.productId ?? "") ?? null,
      {
        candidateProducts: cartItems
          .map((item) => inventoryService.findById(item.productId))
          .filter((item): item is InventoryItem => Boolean(item)),
        purchaseIntentActive
      }
    );

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildMultiItemCheckoutReply(cartItems),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private async handleActiveCartOperations(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    operations: CartOperation[],
    classification: IntentClassification,
    extractedIntents: IntentName[],
    memory: ConversationMemory
  ): Promise<MessageResponse> {
    let cartItems = [...(pendingState.items ?? [])];
    let keepOnlyApplied = false;
    const sortedOperations = [...operations].sort((left, right) => {
      if (left.operation === "keep_only_item" && right.operation !== "keep_only_item") {
        return -1;
      }

      if (right.operation === "keep_only_item" && left.operation !== "keep_only_item") {
        return 1;
      }

      if (left.refersToOthers && !right.refersToOthers) {
        return 1;
      }

      if (right.refersToOthers && !left.refersToOthers) {
        return -1;
      }

      return 0;
    });

    for (const operation of sortedOperations) {
      if (
        keepOnlyApplied &&
        operation.operation === "remove_item" &&
        operation.refersToOthers
      ) {
        continue;
      }

      const result = await this.applyCartOperation(cartItems, operation, memory);

      if (result.type === "clarification") {
        checkoutStateService.set(input.userId, {
          nextStep: "clarify_cart_items",
          items: cartItems,
          pendingItems: [result.pendingItem]
        });

        return {
          channel: "instagram",
          userMessage: input.message,
          intent: "buying_intent",
          productFound: cartItems.length > 0,
          agentReply: this.decorateReplyWithSecondaryIntents(
            buildCartOperationClarificationReply(
              cartItems,
              result.pendingItem,
              operation.operation
            ),
            classification,
            extractedIntents,
            true,
            input.message
          ),
          usedOpenAI: openAiClient.isConfigured(),
          handoff: false
        };
      }

      cartItems = result.cartItems;
      if (operation.operation === "keep_only_item") {
        keepOnlyApplied = true;
      } else if (
        operation.operation === "update_quantity" &&
        operation.useContextTarget &&
        operation.refersToOthers
      ) {
        keepOnlyApplied = true;
      }
    }

    if (cartItems.length === 0) {
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
        productFound: false,
        agentReply: this.decorateReplyWithSecondaryIntents(
          "Perfecto, actualic\u00e9 tu pedido. Tu carrito qued\u00f3 vac\u00edo. Si quer\u00e9s, te ayudo a armar otro \ud83d\ude4c",
          classification,
          extractedIntents,
          false,
          input.message
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    this.persistCheckoutCart(input.userId, cartItems);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildCartModifiedReply(cartItems),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private async handlePendingCartOperations(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    operations: CartOperation[],
    classification: IntentClassification,
    extractedIntents: IntentName[],
    memory: ConversationMemory
  ): Promise<MessageResponse> {
    let cartItems = [...(pendingState.items ?? [])];
    let pendingItems = [...(pendingState.pendingItems ?? [])];
    let keepOnlyApplied = false;
    const sortedOperations = [...operations].sort((left, right) => {
      if (left.operation === "keep_only_item" && right.operation !== "keep_only_item") {
        return -1;
      }

      if (right.operation === "keep_only_item" && left.operation !== "keep_only_item") {
        return 1;
      }

      if (left.refersToOthers && !right.refersToOthers) {
        return 1;
      }

      if (right.refersToOthers && !left.refersToOthers) {
        return -1;
      }

      return 0;
    });

    for (const operation of sortedOperations) {
      if (
        keepOnlyApplied &&
        operation.operation === "remove_item" &&
        operation.refersToOthers
      ) {
        continue;
      }

      const pendingMatches = this.resolvePendingOperationMatches(
        pendingItems,
        operation
      );

      if (pendingMatches.length === 1) {
        const targetPendingItem = pendingMatches[0];

        if (operation.operation === "remove_item") {
          pendingItems = removePendingItemQuantity(
            pendingItems,
            targetPendingItem,
            operation.quantity
          );
          continue;
        }

        if (operation.operation === "update_quantity") {
          pendingItems = updatePendingItemQuantity(
            pendingItems,
            targetPendingItem,
            operation.quantity ?? 1
          );
          continue;
        }

        if (operation.operation === "keep_only_item") {
          const nextQuantity = operation.quantity ?? targetPendingItem.quantity;

          cartItems = [];
          pendingItems = [
            {
              ...targetPendingItem,
              quantity: nextQuantity
            }
          ];
          keepOnlyApplied = true;
          continue;
        }

        if (operation.operation === "replace_item" && operation.replacementItem) {
          const replacementItem: PendingCartItem = {
            productName: operation.replacementItem.productName,
            category: operation.replacementItem.category,
            color: operation.replacementItem.color,
            quantity:
              operation.replacementItem.quantity > 0
                ? operation.replacementItem.quantity
                : targetPendingItem.quantity,
            keywords: operation.replacementItem.keywords
          };
          const remainingPendingItems = pendingItems.filter(
            (item) => item !== targetPendingItem
          );
          const replacementResolution = this.resolvePurchaseItems([replacementItem]);

          pendingItems = [
            ...remainingPendingItems,
            ...replacementResolution.pendingItems
          ];
          cartItems = mergeCheckoutCartItems(
            cartItems,
            replacementResolution.resolvedItems.map((item) => item.cartItem)
          );
          continue;
        }
      }

      const result = await this.applyCartOperation(cartItems, operation, memory);

      if (result.type === "clarification") {
        if (operation.operation === "add_item") {
          pendingItems = [...pendingItems, result.pendingItem];
          continue;
        }

        checkoutStateService.set(input.userId, {
          nextStep: "clarify_cart_items",
          items: cartItems,
          pendingItems: [result.pendingItem, ...pendingItems]
        });

        return {
          channel: "instagram",
          userMessage: input.message,
          intent: "buying_intent",
          productFound: cartItems.length > 0,
          agentReply: this.decorateReplyWithSecondaryIntents(
            buildCartOperationClarificationReply(
              cartItems,
              result.pendingItem,
              operation.operation
            ),
            classification,
            extractedIntents,
            cartItems.length > 0,
            input.message
          ),
          usedOpenAI: openAiClient.isConfigured(),
          handoff: false
        };
      }

      cartItems = result.cartItems;

      if (operation.operation === "keep_only_item") {
        keepOnlyApplied = true;
        pendingItems = [];
      } else if (
        operation.operation === "update_quantity" &&
        operation.useContextTarget &&
        operation.refersToOthers
      ) {
        keepOnlyApplied = true;
      }
    }

    if (cartItems.length === 0 && pendingItems.length === 0) {
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
        productFound: false,
        agentReply: this.decorateReplyWithSecondaryIntents(
          "Perfecto, actualic\u00e9 tu pedido. Tu carrito qued\u00f3 vac\u00edo. Si quer\u00e9s, te ayudo a armar otro \ud83d\ude4c",
          classification,
          extractedIntents,
          false,
          input.message
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    if (pendingItems.length > 0) {
      checkoutStateService.set(input.userId, {
        nextStep: "clarify_cart_items",
        items: cartItems,
        pendingItems
      });

      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: cartItems.length > 0,
        agentReply: this.decorateReplyWithSecondaryIntents(
          buildPartialCartClarificationReply(cartItems, pendingItems[0]),
          classification,
          extractedIntents,
          cartItems.length > 0,
          input.message
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    this.persistCheckoutCart(input.userId, cartItems);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildCartModifiedReply(cartItems),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private async handleActiveCartUpdate(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    classification: IntentClassification,
    requestedItems: PurchaseItemInput[],
    extractedIntents: IntentName[]
  ): Promise<MessageResponse> {
    const existingCartItems = pendingState.items ?? [];
    const pendingCartItems = this.buildPendingCartItems(
      classification,
      requestedItems
    );

    if (pendingCartItems.length === 0) {
      return this.buildPendingCartResponse(input, pendingState);
    }

    const resolution = this.resolvePurchaseItems(pendingCartItems);
    const resolvedCartItems = resolution.resolvedItems.map((item) => item.cartItem);
    const updatedCartItems = mergeCheckoutCartItems(
      existingCartItems,
      resolvedCartItems
    );

    if (resolution.pendingItems.length > 0) {
      checkoutStateService.set(input.userId, {
        nextStep: "clarify_cart_items",
        items: updatedCartItems,
        pendingItems: resolution.pendingItems
      });

      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: updatedCartItems.length > 0,
        agentReply: this.decorateReplyWithSecondaryIntents(
          buildPartialCartClarificationReply(
            updatedCartItems,
            resolution.pendingItems[0]
          ),
          classification,
          extractedIntents,
          true,
          input.message
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    this.persistCheckoutCart(input.userId, updatedCartItems);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildCartUpdatedReply(updatedCartItems, resolvedCartItems),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private async applyCartOperation(
    currentCartItems: CheckoutCartItem[],
    operation: CartOperation,
    memory: ConversationMemory
  ): Promise<
    | { type: "success"; cartItems: CheckoutCartItem[] }
    | { type: "clarification"; pendingItem: PendingCartItem }
  > {
    if (operation.operation === "add_item") {
      const pendingItem = this.toPendingCartItem(operation);
      const resolution = this.resolvePurchaseItems([pendingItem]);

      if (resolution.pendingItems.length > 0) {
        return {
          type: "clarification",
          pendingItem: resolution.pendingItems[0]
        };
      }

      return {
        type: "success",
        cartItems: mergeCheckoutCartItems(
          currentCartItems,
          resolution.resolvedItems.map((item) => item.cartItem)
        )
      };
    }

    const operationTarget = this.toPendingCartItem(operation);
    const matchedCartItems = this.resolveCartOperationMatches(
      currentCartItems,
      operation,
      memory
    );

    if (
      operation.operation === "remove_item" &&
      matchedCartItems.length > 1 &&
      shouldRemoveMatchedGroup(operation)
    ) {
      return {
        type: "success",
        cartItems: removeCartItemGroup(currentCartItems, matchedCartItems)
      };
    }

    if (matchedCartItems.length !== 1) {
      return {
        type: "clarification",
        pendingItem: operationTarget
      };
    }

    const targetCartItem = matchedCartItems[0];

    if (operation.operation === "remove_item") {
      return {
        type: "success",
        cartItems: removeCartItemQuantity(
          currentCartItems,
          targetCartItem,
          operation.quantity
        )
      };
    }

    if (operation.operation === "update_quantity") {
      return {
        type: "success",
        cartItems: updateCartItemQuantity(
          currentCartItems,
          targetCartItem,
          operation.quantity ?? 1
        )
      };
    }

    if (operation.operation === "keep_only_item") {
      const nextQuantity = operation.quantity ?? targetCartItem.quantity;

      if (operation.useContextTarget && operation.quantity !== null) {
        return {
          type: "success",
          cartItems: updateCartItemQuantity(
            currentCartItems,
            targetCartItem,
            nextQuantity
          )
        };
      }

      return {
        type: "success",
        cartItems: [
          {
            ...targetCartItem,
            quantity: nextQuantity,
            subtotal: nextQuantity * targetCartItem.unitPrice
          }
        ]
      };
    }

    const replacementItem = operation.replacementItem
      ? {
          ...operation.replacementItem,
          category: operation.replacementItem.category ?? operationTarget.category,
          quantity:
            operation.replacementItem.quantity > 0
              ? operation.replacementItem.quantity
              : targetCartItem.quantity
        }
      : null;

    if (!replacementItem) {
      return {
        type: "clarification",
        pendingItem: operationTarget
      };
    }

    const replacementResolution = this.resolvePurchaseItems([replacementItem]);

    if (replacementResolution.pendingItems.length > 0) {
      return {
        type: "clarification",
        pendingItem: replacementResolution.pendingItems[0]
      };
    }

    const cartWithoutTarget = removeCartItemQuantity(
      currentCartItems,
      targetCartItem,
      null
    );

    return {
      type: "success",
      cartItems: mergeCheckoutCartItems(
        cartWithoutTarget,
        replacementResolution.resolvedItems.map((item) => item.cartItem)
      )
    };
  }

  private async handlePendingCartClarification(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    classification: IntentClassification
  ): Promise<MessageResponse> {
    const pendingItems = pendingState.pendingItems ?? [];

    if (pendingItems.length === 0) {
      checkoutStateService.clear(input.userId);
      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "unknown",
        productFound: false,
        agentReply:
          "Se perdi\u00f3 el detalle pendiente de la compra. Si quer\u00e9s, decime los productos de nuevo y lo retomamos.",
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    const extractedItems = await extractPurchaseItems(input.message);
    const firstPendingItem = pendingItems[0];
    const mergedPendingItem = mergePendingItem(
      firstPendingItem,
      extractedItems[0],
      classification
    );
    const resolvedPendingItem = this.resolvePurchaseItems([mergedPendingItem]);

    if (resolvedPendingItem.pendingItems.length > 0) {
      checkoutStateService.set(input.userId, {
        nextStep: "clarify_cart_items",
        items: pendingState.items ?? [],
        pendingItems: [resolvedPendingItem.pendingItems[0], ...pendingItems.slice(1)]
      });

      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: (pendingState.items ?? []).length > 0,
        agentReply: buildPartialCartClarificationReply(
          pendingState.items ?? [],
          resolvedPendingItem.pendingItems[0]
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    const clarifiedItems = [
      ...(pendingState.items ?? []),
      ...resolvedPendingItem.resolvedItems.map((item) => item.cartItem)
    ];
    const remainingPendingItems = pendingItems.slice(1);

    if (remainingPendingItems.length > 0) {
      checkoutStateService.set(input.userId, {
        nextStep: "clarify_cart_items",
        items: clarifiedItems,
        pendingItems: remainingPendingItems
      });

      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: true,
        agentReply: buildPartialCartClarificationReply(
          clarifiedItems,
          remainingPendingItems[0]
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    this.persistCheckoutCart(input.userId, clarifiedItems);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: buildMultiItemCheckoutReply(clarifiedItems),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private resolvePurchaseItems(
    requestedItems: PendingCartItem[]
  ): PurchaseResolution {
    const resolvedItems: ResolvedPurchaseItem[] = [];
    const pendingItems: PendingCartItem[] = [];

    for (const requestedItem of requestedItems) {
      const exactProduct = this.findUniqueCartProduct(requestedItem);

      if (exactProduct) {
        resolvedItems.push({
          requestedItem,
          cartItem: {
            productId: exactProduct.id,
            productName: exactProduct.name,
            quantity: requestedItem.quantity,
            unitPrice: exactProduct.price,
            currency: exactProduct.currency,
            subtotal: exactProduct.price * requestedItem.quantity
          }
        });
        continue;
      }

      const searchInput = buildCartSearchInput(requestedItem);
      const result = inventoryService.findMatch(searchInput);
      const product = result.product ?? null;

      if (!product || result.alternatives.length > 0) {
        pendingItems.push(requestedItem);
        continue;
      }

      resolvedItems.push({
        requestedItem,
        cartItem: {
          productId: product.id,
          productName: product.name,
          quantity: requestedItem.quantity,
          unitPrice: product.price,
          currency: product.currency,
          subtotal: product.price * requestedItem.quantity
        }
      });
    }

    return {
      resolvedItems,
      pendingItems
    };
  }

  private findUniqueCartProduct(requestedItem: PendingCartItem): InventoryItem | null {
    const candidates = inventoryService.getInventory().filter((item) =>
      matchesRequestedCartItem(item, requestedItem)
    );

    return candidates.length === 1 ? candidates[0] : null;
  }

  private buildPendingCartItems(
    classification: IntentClassification,
    requestedItems: PurchaseItemInput[]
  ): PendingCartItem[] {
    if (requestedItems.length > 0) {
      return requestedItems.map((item) => ({
        productName: item.productName,
        category: item.category,
        color: item.color,
        quantity: item.quantity,
        keywords: item.keywords
      }));
    }

    if (
      classification.productName ||
      classification.category ||
      classification.color
    ) {
      return [
        {
          productName: classification.productName,
          category: classification.category,
          color: classification.color,
          quantity: classification.quantity ?? 1,
          keywords: []
        }
      ];
    }

    return [];
  }

  private toPendingCartItem(operation: CartOperation): PendingCartItem {
    return {
      productName: operation.productName,
      category: operation.category,
      color: operation.color,
      quantity: operation.quantity ?? 1,
      keywords: operation.keywords
    };
  }

  private persistCheckoutCart(userId: string, cartItems: CheckoutCartItem[]): void {
    if (cartItems.length === 0) {
      return;
    }

    checkoutStateService.set(userId, {
      nextStep: "collect_order_data",
      productId: cartItems[0].productId,
      productName: cartItems[0].productName,
      quantity: cartItems.length === 1 ? cartItems[0].quantity : null,
      items: cartItems
    });
  }

  private buildPendingCartResponse(
    input: HandleMessageInput,
    pendingState: CheckoutState
  ): MessageResponse {
    const cartItems = pendingState.items ?? [];

    if (pendingState.nextStep === "clarify_cart_items") {
      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: cartItems.length > 0,
        agentReply: buildPartialCartClarificationReply(
          cartItems,
          pendingState.pendingItems?.[0] ?? {
            productName: null,
            category: null,
            color: null,
            quantity: 1,
            keywords: []
          }
        ),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: cartItems.length > 0,
      agentReply: buildResumeCartReply(cartItems),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: cartItems.length > 0,
      nextStep: cartItems.length > 0 ? "collect_order_data" : undefined
    };
  }

  private hasActiveCartItems(pendingState: CheckoutState): boolean {
    return (pendingState.items ?? []).length > 0;
  }

  private findCartMatches(
    cartItems: CheckoutCartItem[],
    pendingItem: PendingCartItem
  ): CheckoutCartItem[] {
    return cartItems.filter((cartItem) => {
      const inventoryItem = inventoryService.findById(cartItem.productId);

      return inventoryItem ? matchesRequestedCartItem(inventoryItem, pendingItem) : false;
    });
  }

  private shouldReduceSingleCartItem(
    pendingState: CheckoutState,
    message: string,
    classification: IntentClassification
  ): boolean {
    const cartItems = pendingState.items ?? [];
    const normalized = normalizeResumeMessage(message);

    return (
      cartItems.length === 1 &&
      Boolean(classification.quantity) &&
      (normalized.includes("solo quiero") ||
        normalized.includes("ya solo quiero") ||
        normalized.includes("dejame solo"))
    );
  }

  private handleSingleCartItemReduction(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    classification: IntentClassification,
    extractedIntents: IntentName[]
  ): MessageResponse {
    const currentItem = pendingState.items?.[0];

    if (!currentItem) {
      return this.buildPendingCartResponse(input, pendingState);
    }

    const nextQuantity = classification.quantity ?? 1;
    const updatedCartItems = [
      {
        ...currentItem,
        quantity: nextQuantity,
        subtotal: nextQuantity * currentItem.unitPrice
      }
    ];

    this.persistCheckoutCart(input.userId, updatedCartItems);

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildCartModifiedReply(updatedCartItems),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private resolveCartOperationMatches(
    cartItems: CheckoutCartItem[],
    operation: CartOperation,
    memory: ConversationMemory
  ): CheckoutCartItem[] {
    const targetItem = this.toPendingCartItem(operation);
    const hasExplicitTarget = Boolean(
      targetItem.productName ||
        targetItem.category ||
        targetItem.color ||
        targetItem.keywords.length > 0
    );
    const directMatches = hasExplicitTarget
      ? this.findCartMatches(cartItems, targetItem)
      : [];

    if (directMatches.length > 0 || !operation.useContextTarget) {
      return directMatches;
    }

    const focusedCartItem = this.getFocusedCartItem(cartItems, memory);
    if (focusedCartItem) {
      return [focusedCartItem];
    }

    if (cartItems.length === 1) {
      return cartItems;
    }

    const multiQuantityMatches = cartItems.filter((item) => item.quantity > 1);
    if (multiQuantityMatches.length === 1) {
      return multiQuantityMatches;
    }

    if (operation.refersToOthers) {
      return [];
    }

    return [];
  }

  private getFocusedCartItem(
    cartItems: CheckoutCartItem[],
    memory: ConversationMemory
  ): CheckoutCartItem | null {
    const focusedProductId = memory.lastMentionedProduct?.id;

    if (!focusedProductId) {
      return null;
    }

    return cartItems.find((item) => item.productId === focusedProductId) ?? null;
  }

  private resolvePendingOperationMatches(
    pendingItems: PendingCartItem[],
    operation: CartOperation
  ): PendingCartItem[] {
    const targetItem = this.toPendingCartItem(operation);
    const hasExplicitTarget = Boolean(
      targetItem.productName ||
        targetItem.category ||
        targetItem.color ||
        targetItem.keywords.length > 0
    );
    const directMatches = hasExplicitTarget
      ? pendingItems.filter((pendingItem) =>
          matchesPendingOperationTarget(pendingItem, targetItem)
        )
      : [];

    if (directMatches.length > 0 || !operation.useContextTarget) {
      return directMatches;
    }

    if (pendingItems.length === 1) {
      return pendingItems;
    }

    const multiQuantityMatches = pendingItems.filter((item) => item.quantity > 1);
    if (multiQuantityMatches.length === 1) {
      return multiQuantityMatches;
    }

    if (operation.refersToOthers) {
      return [];
    }

    return [];
  }

  private shouldAppendToActiveCart(
    message: string,
    classification: IntentClassification,
    requestedItems: PurchaseItemInput[]
  ): boolean {
    if (
      isShortReferenceMessage(message) &&
      !looksLikeDirectBuyingMessage(message)
    ) {
      return false;
    }

    if (looksLikeCartAppendMessage(message)) {
      return true;
    }

    return (
      classification.intent === "buying_intent" &&
      requestedItems.length > 0
    );
  }

  private looksLikeCartReferenceMessage(
    message: string,
    classification: IntentClassification
  ): boolean {
    const normalized = normalizeResumeMessage(message);

    if (
      this.isFaqIntent(classification) ||
      classification.intent === "greeting" ||
      looksLikeResumePurchaseMessage(message) ||
      looksLikeOrderDataMessage(message) ||
      looksLikeCartAppendMessage(message) ||
      hasExplicitCartOperationLanguage(normalized) ||
      looksLikeDirectBuyingMessage(message)
    ) {
      return false;
    }

    return Boolean(
      classification.refersToPreviousProduct ||
        classification.productName ||
        classification.category ||
        classification.color ||
        isCandidateSelectionReference(message) ||
        normalized.startsWith("la ") ||
        normalized.startsWith("el ")
    );
  }

  private handleActiveCartReference(
    input: HandleMessageInput,
    pendingState: CheckoutState,
    classification: IntentClassification,
    extractedIntents: IntentName[],
    memory: ConversationMemory
  ): MessageResponse {
    const cartItems = pendingState.items ?? [];
    const matches = this.resolveCartReferenceMatches(
      cartItems,
      classification,
      input.message,
      memory
    );

    if (matches.length > 1) {
      return {
        channel: "instagram",
        userMessage: input.message,
        intent: "buying_intent",
        productFound: true,
        agentReply: buildCartReferenceClarificationReply(matches),
        usedOpenAI: openAiClient.isConfigured(),
        handoff: false
      };
    }

    if (matches.length === 0) {
      return this.buildPendingCartResponse(input, pendingState);
    }

    const focusedCartItem = matches[0];
    const focusedProduct =
      inventoryService.findById(focusedCartItem.productId) ?? null;

    if (focusedProduct) {
      conversationMemoryService.remember(input.userId, {
        product: focusedProduct,
        candidateProducts: [focusedProduct],
        purchaseIntentActive: true
      });
    }

    return {
      channel: "instagram",
      userMessage: input.message,
      intent: "buying_intent",
      productFound: true,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildCartReferenceReply(focusedCartItem),
        classification,
        extractedIntents,
        true,
        input.message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: true,
      nextStep: "collect_order_data"
    };
  }

  private resolveCartReferenceMatches(
    cartItems: CheckoutCartItem[],
    classification: IntentClassification,
    message: string,
    memory: ConversationMemory
  ): CheckoutCartItem[] {
    if (cartItems.length === 0) {
      return [];
    }

    const referenceItem: PendingCartItem = {
      productName: classification.productName,
      category: classification.category,
      color: classification.color,
      quantity: classification.quantity ?? 1,
      keywords: []
    };
    const directMatches = this.findCartMatches(cartItems, referenceItem);

    if (directMatches.length > 0) {
      return directMatches;
    }

    if (
      (classification.refersToPreviousProduct || isCandidateSelectionReference(message)) &&
      memory.lastMentionedProduct
    ) {
      const focusedCartItem = this.getFocusedCartItem(cartItems, memory);

      if (focusedCartItem) {
        return [focusedCartItem];
      }
    }

    if (cartItems.length === 1 && isShortReferenceMessage(message)) {
      return cartItems;
    }

    return [];
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

  private applyPrimaryIntent(
    classification: IntentClassification,
    detectedIntents: IntentName[]
  ): IntentClassification {
    const primaryIntent = detectedIntents[0];

    if (!primaryIntent || primaryIntent === classification.intent) {
      return classification;
    }

    return {
      ...classification,
      intent: primaryIntent
    };
  }

  private enrichDetectedIntents(
    detectedIntents: IntentName[],
    classification: IntentClassification,
    message: string
  ): IntentName[] {
    const enriched = [...detectedIntents];

    if (
      classification.intent === "buying_intent" ||
      looksLikeDirectBuyingMessage(message)
    ) {
      enriched.push("buying_intent");
    }

    if (looksLikeExplicitPriceMessage(message)) {
      enriched.push("price_question");
    }

    if (looksLikeGreetingMessage(message)) {
      enriched.push("greeting");
    }

    for (const faqIntent of detectFaqIntentsFromMessage(message)) {
      enriched.push(faqIntent);
    }

    return [...new Set(enriched)];
  }

  private decorateReplyWithSecondaryIntents(
    baseReply: string,
    classification: IntentClassification,
    extractedIntents: string[],
    hasPendingPurchaseContext: boolean,
    message: string
  ): string {
    const secondaryIntents = extractedIntents
      .filter((intent) => intent !== classification.intent)
      .slice(0, 3) as IntentName[];
    const parts: string[] = [];

    if (
      secondaryIntents.includes("greeting") &&
      classification.intent !== "buying_intent"
    ) {
      parts.push(buildGreetingLead(message, classification.tone));
    }

    parts.push(baseReply);

    const secondaryProductReply = this.buildSecondaryProductReply(
      message,
      classification,
      secondaryIntents
    );
    if (secondaryProductReply) {
      parts.push(secondaryProductReply);
    }

    for (const intent of secondaryIntents) {
      if (
        !isFaqIntentName(intent) ||
        intent === "product_search" ||
        intent === "collection_request" ||
        intent === "price_question" ||
        intent === "product_availability"
      ) {
        continue;
      }

      const faqIntents = secondaryIntents.filter(isFaqIntentName);

      if (classification.intent === "buying_intent" && faqIntents.length > 0) {
        parts.push(
          buildFaqSummaryReply(faqIntents, {
            isSameTurnBuyingIntent: true
          })
        );
        break;
      }

      parts.push(
        buildFaqReply(
          {
            ...classification,
            intent
          },
          {
            hasPendingPurchaseContext
          }
        )
      );
    }

    return [...new Set(parts.filter(Boolean))].join("\n");
  }

  private buildSecondaryProductReply(
    message: string,
    classification: IntentClassification,
    secondaryIntents: IntentName[]
  ): string | null {
    if (
      !secondaryIntents.some((intent) =>
        [
          "product_search",
          "collection_request",
          "price_question",
          "product_availability"
        ].includes(intent)
      )
    ) {
      return null;
    }

    const queryClause = extractSecondaryProductClause(message);
    if (!queryClause) {
      return null;
    }

    const category = normalizeCategoryLabel(inferCategoryFromMessage(queryClause));
    const color = normalizeColorLabel(inferColorFromMessage(queryClause));
    const productName = category ? null : buildSecondaryProductHint(queryClause);
    const searchResult = inventoryService.findMatch({
      productName,
      category,
      color
    });

    if (searchResult.product) {
      return `Y sobre eso, ${searchResult.product.name} cuesta ${searchResult.product.price} ${searchResult.product.currency}.`;
    }

    if (searchResult.products.length > 0) {
      const items = searchResult.products
        .slice(0, 4)
        .map((item) => `${item.name} (${item.price} ${item.currency})`)
        .join(", ");
      const intro =
        category && color
          ? `Y en ${pluralizeCategory(category)} ${normalizeDisplayColor(color)} tenemos`
          : category
            ? `Y de ${pluralizeCategory(category)} tenemos`
            : color
              ? `Y en ${normalizeDisplayColor(color)} tenemos`
              : "Y también tenemos";

      return `${intro}: ${items}.`;
    }

    if (classification.intent === "buying_intent") {
      return "Sobre esa otra consulta, si querés decime el producto exacto y te lo ubico rápido.";
    }

    return null;
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
      (classification.isListRequest && Boolean(classification.category)) ||
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
    userId: string,
    hasPendingPurchaseContext: boolean,
    extractedIntents: string[]
  ): MessageResponse {
    const faqIntents = [
      classification.intent,
      ...(extractedIntents as IntentName[])
    ];
    const uniqueFaqIntents = [...new Set(faqIntents.filter(isFaqIntentName))];
    const secondaryNonFaqIntents = extractedIntents.filter(
      (intent) => !isFaqIntentName(intent as IntentName)
    ) as IntentName[];

    conversationMemoryService.remember(userId, {
      intent: classification.intent
    });

    return {
      channel: "instagram",
      userMessage: message,
      intent: classification.intent,
      productFound: false,
      agentReply: this.decorateReplyWithSecondaryIntents(
        uniqueFaqIntents.length > 1
          ? buildFaqSummaryReply(uniqueFaqIntents, {
              hasPendingPurchaseContext
            })
          : buildFaqReply(classification, {
              hasPendingPurchaseContext
            }),
        classification,
        secondaryNonFaqIntents,
        hasPendingPurchaseContext,
        message
      ),
      usedOpenAI: openAiClient.isConfigured(),
      handoff: false
    };
  }

  private buildGreetingResponse(
    message: string,
    classification: IntentClassification,
    userId: string,
    extractedIntents: string[]
  ): MessageResponse {
    conversationMemoryService.remember(userId, {
      intent: classification.intent
    });

    return {
      channel: "instagram",
      userMessage: message,
      intent: classification.intent,
      productFound: false,
      agentReply: this.decorateReplyWithSecondaryIntents(
        buildGreetingReply(message, classification.tone),
        classification,
        extractedIntents,
        false,
        message
      ),
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
  return `Quiero asegurarme de darte el producto correcto. ¿Te refer\u00eds a ${names}?`;
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
    missingFields.push("tu direcci\u00f3n de entrega");
  }

  if (!data.paymentMethod) {
    missingFields.push("tu m\u00e9todo de pago preferido");
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
    return "Claro, te ayudo con la compra. Decime qu\u00e9 producto quer\u00e9s llevar para aplicar esa cantidad.";
  }

  return "Claro, te ayudo con la compra. Decime cu\u00e1l producto te interesa para seguir.";
}

function looksLikeOrderDataMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);
  const looksLikeCartEdit =
    looksLikeResumePurchaseMessage(message) ||
    looksLikeCartAppendMessage(message) ||
    normalized.includes("sabes que") ||
    normalized.includes("mejor") ||
    normalized.includes("quit") ||
    normalized.includes("cambi") ||
    normalized.includes("dejame solo") ||
    normalized.includes("solo quiero") ||
    normalized.includes("ya solo quiero") ||
    Boolean(inferCategoryFromMessage(message)) ||
    Boolean(inferColorFromMessage(message));

  if (looksLikeCartEdit) {
    return false;
  }

  const hasCommaSeparatedData = message.split(",").filter(Boolean).length >= 2;
  const mentionsPayment =
    normalized.includes("transfer") ||
    normalized.includes("tarjeta") ||
    normalized.includes("efectivo");

  return hasCommaSeparatedData || mentionsPayment;
}

function inferCategoryFromMessage(message: string): string | null {
  const normalized = normalizeResumeMessage(message);
  const categoryAliases: Record<string, string> = {
    hoodie: "hoodie",
    hoodies: "hoodie",
    hudi: "hoodie",
    sudadera: "hoodie",
    sudaderas: "hoodie",
    jogger: "jogger",
    joggers: "jogger",
    yugers: "jogger",
    camiseta: "camiseta",
    camisetas: "camiseta",
    camisa: "camiseta",
    camisas: "camiseta",
    playera: "camiseta",
    playeras: "camiseta",
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
  const normalized = normalizeResumeMessage(message);
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

  const normalizedCategory = normalizeResumeMessage(category);

  if (
    normalizedCategory === "ropa" ||
    normalizedCategory === "clothing" ||
    normalizedCategory === "prenda"
  ) {
    return null;
  }

  const aliases: Record<string, string> = {
    hoodie: "hoodie",
    hoodies: "hoodie",
    hudi: "hoodie",
    sudadera: "hoodie",
    sudaderas: "hoodie",
    jogger: "jogger",
    joggers: "jogger",
    yugers: "jogger",
    camiseta: "camiseta",
    camisetas: "camiseta",
    camisa: "camiseta",
    camisas: "camiseta",
    playera: "camiseta",
    playeras: "camiseta",
    gorra: "gorra",
    gorras: "gorra",
    polo: "polo",
    polos: "polo",
    oversize: "camiseta",
    oversized: "camiseta",
    short: "short",
    shorts: "short",
    pantaloneta: "short",
    pantalonetas: "short"
  };

  return aliases[normalizedCategory] ?? normalizedCategory;
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
  const normalized = normalizeResumeMessage(message);
  const isCasual =
    tone === "casual" ||
    normalized.includes("bro") ||
    normalized.includes("man") ||
    normalized.includes("q ondas") ||
    normalized.includes("que ondas");

  if (isCasual) {
    return "\u00a1Buenas! Decime qu\u00e9 producto and\u00e1s buscando y te ayudo.";
  }

  if (normalized.includes("buenas")) {
    return "\u00a1Buenas! Si quer\u00e9s, te puedo ayudar con productos, precios o disponibilidad.";
  }

  return "\u00a1Hola! \ud83d\udc4b \u00bfEn qu\u00e9 te puedo ayudar hoy?";
}

function buildGreetingLead(message: string, tone: string): string {
  const normalized = normalizeResumeMessage(message);
  const isCasual =
    tone === "casual" ||
    normalized.includes("bro") ||
    normalized.includes("man");

  return isCasual ? "\u00a1Buenas!" : "\u00a1Hola!";
}

function looksLikeGreetingMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("hola") ||
    normalized.includes("buenas") ||
    normalized.includes("bro") ||
    normalized.includes("man")
  );
}

function looksLikeDirectBuyingMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("quiero comprar") ||
    normalized.includes("quiero un") ||
    normalized.includes("quiero una") ||
    normalized.includes("dame un") ||
    normalized.includes("dame una") ||
    normalized.includes("llevar") ||
    normalized.includes("pedido") ||
    normalized.includes("apartar")
  );
}

function looksLikeExplicitPriceMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("cuanto vale") ||
    normalized.includes("cuanto cuesta") ||
    normalized.includes("cuanto es") ||
    normalized.includes("precio")
  );
}

function prioritizeDetectedIntents(intents: IntentName[]): IntentName[] {
  return [...new Set(intents)]
    .filter((intent) => intent !== "unknown")
    .sort((left, right) => getIntentPriority(left) - getIntentPriority(right))
    .slice(0, 4);
}

function getIntentPriority(intent: IntentName): number {
  if (intent === "buying_intent") {
    return 1;
  }

  if (
    intent === "product_search" ||
    intent === "price_question" ||
    intent === "product_availability" ||
    intent === "collection_request"
  ) {
    return 2;
  }

  if (isFaqIntentName(intent)) {
    return 3;
  }

  if (intent === "greeting") {
    return 4;
  }

  return 5;
}

function isFaqIntentName(intent: IntentName): boolean {
  return [
    "faq_location",
    "faq_hours",
    "faq_payment",
    "faq_shipping"
  ].includes(intent);
}

function buildFaqSummaryReply(
  intents: IntentName[],
  options: {
    hasPendingPurchaseContext?: boolean;
    isSameTurnBuyingIntent?: boolean;
  } = {}
): string {
  const faqLabels = intents
    .filter(isFaqIntentName)
    .map((intent) => mapFaqIntentToLabel(intent));
  const suffix = options.isSameTurnBuyingIntent
    ? ""
    : options.hasPendingPurchaseContext
      ? " Si quer\u00e9s, seguimos con tu pedido \ud83d\ude4c"
      : "";

  if (faqLabels.length === 0) {
    return "";
  }

  if (faqLabels.length === 1) {
    return `Sobre ${faqLabels[0]}, el equipo te confirma ese detalle por este medio.${suffix}`;
  }

  if (faqLabels.length === 2) {
    return `Sobre ${faqLabels[0]} y ${faqLabels[1]}, el equipo te confirma esos detalles por este medio.${suffix}`;
  }

  return `Sobre ${faqLabels.slice(0, -1).join(", ")} y ${faqLabels[faqLabels.length - 1]}, el equipo te confirma esos detalles por este medio.${suffix}`;
}

function mapFaqIntentToLabel(intent: IntentName): string {
  switch (intent) {
    case "faq_location":
      return "ubicaci\u00f3n";
    case "faq_hours":
      return "horario";
    case "faq_payment":
      return "m\u00e9todos de pago";
    case "faq_shipping":
      return "env\u00edos";
    default:
      return "ese detalle";
  }
}

function detectFaqIntentsFromMessage(message: string): IntentName[] {
  const normalized = normalizeResumeMessage(message);
  const intents: IntentName[] = [];

  if (
    normalized.includes("envio") ||
    normalized.includes("envian") ||
    normalized.includes("delivery")
  ) {
    intents.push("faq_shipping");
  }

  if (
    normalized.includes("pago") ||
    normalized.includes("transferencia") ||
    normalized.includes("metodos de pago") ||
    normalized.includes("aceptan tarjeta")
  ) {
    intents.push("faq_payment");
  }

  if (
    normalized.includes("donde estan") ||
    normalized.includes("ubicacion") ||
    normalized.includes("ubicados") ||
    normalized.includes("direccion")
  ) {
    intents.push("faq_location");
  }

  if (
    normalized.includes("horario") ||
    normalized.includes("abren") ||
    normalized.includes("cierran")
  ) {
    intents.push("faq_hours");
  }

  return [...new Set(intents)];
}

function extractSecondaryProductClause(message: string): string | null {
  const clauses = message
    .split(/,|\sy\s/gi)
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    clauses.find((clause) => {
      const normalized = normalizeResumeMessage(clause);
      return (
        (normalized.includes("dime") ||
          normalized.includes("que ") ||
          normalized.includes("tienen") ||
          normalized.includes("muestra") ||
          normalized.includes("mostra")) &&
        !detectFaqIntentsFromMessage(clause).length
      );
    }) ?? null
  );
}

function stripSecondaryProductClause(message: string): string {
  const queryClause = extractSecondaryProductClause(message);

  if (!queryClause) {
    return message;
  }

  return message.replace(queryClause, "").replace(/\s+,/g, ",").trim();
}

function buildSecondaryProductHint(message: string): string | null {
  const normalized = normalizeResumeMessage(message);
  const hint = normalized
    .replace(/\b(dime|decime|que|que tienen|tienen|muestra|mostra|tambien|tambien quiero|y)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return hint.length > 0 ? hint : null;
}

function looksLikePurchaseIntentMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("quiero comprar") ||
    normalized.includes("me interesa comprar") ||
    normalized.includes("quiero uno") ||
    normalized.includes("quiero dos")
  );
}

function looksLikeCartAppendMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("tambien") ||
    normalized.includes("también") ||
    normalized.includes("agrega") ||
    normalized.includes("agrega") ||
    normalized.includes("agregue") ||
    normalized.includes("sumale") ||
    normalized.includes("suma") ||
    normalized.includes("dame") ||
    normalized.includes("poneme")
  );
}

function hasExplicitCartOperationLanguage(message: string): boolean {
  return (
    message.includes("agreg") ||
    message.includes("suma") ||
    message.includes("quita") ||
    message.includes("quitame") ||
    message.includes("saca") ||
    message.includes("ya no quiero") ||
    message.includes("solo quiero") ||
    message.includes("ya solo quiero") ||
    message.includes("dejame") ||
    message.includes("unicamente") ||
    message.includes("todo menos") ||
    message.includes("cambia") ||
    message.includes("cambiame")
  );
}

function looksLikeResumePurchaseMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);
  const exactMatches = new Set([
    "sigamos",
    "sigamos pues",
    "dale",
    "dale pues",
    "dale bro",
    "ok",
    "ok segui",
    "ok segui pues",
    "vamos",
    "continuemos",
    "seguimos",
    "de una",
    "metele",
    "va pues",
    "vaya pues",
    "si sigamos",
    "prosiga"
  ]);

  if (exactMatches.has(normalized)) {
    return true;
  }

  return (
    normalized.startsWith("sigamos") ||
    normalized.startsWith("seguimos") ||
    normalized.startsWith("continuemos") ||
    normalized.startsWith("dale") ||
    normalized.startsWith("ok segui") ||
    normalized.startsWith("si sigamos") ||
    normalized.startsWith("vaya pues") ||
    normalized.startsWith("va pues")
  );
}

function isCandidateSelectionReference(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.includes("uno") ||
    normalized.includes("dos") ||
    normalized.includes("esa") ||
    normalized.includes("ese") ||
    normalized.includes("eso")
  );
}

function isShortReferenceMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);

  return (
    normalized.startsWith("la ") ||
    normalized.startsWith("el ") ||
    normalized.startsWith("esa") ||
    normalized.startsWith("ese") ||
    normalized.startsWith("eso")
  );
}

function isCheckoutCancellationMessage(message: string): boolean {
  const normalized = normalizeResumeMessage(message);
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

  const mentionsSpecificProduct =
    Boolean(inferCategoryFromMessage(message)) ||
    Boolean(inferColorFromMessage(message)) ||
    isCandidateSelectionReference(message) ||
    normalized.includes("las otras") ||
    normalized.includes("los otros") ||
    normalized.includes("lo otro");

  if (mentionsSpecificProduct) {
    return false;
  }

  return cancellationPhrases.some((phrase) => normalized.includes(phrase));
}

function buildCheckoutCancellationReply(message: string): string {
  const normalized = normalizeResumeMessage(message);

  if (normalized.includes("despues")) {
    return "Est\u00e1 bien \ud83d\ude4c Si despu\u00e9s quer\u00e9s retomarlo o ver otro producto, aqu\u00ed estoy.";
  }

  if (normalized.includes("man") || normalized.includes("nel")) {
    return "Dale, sin problema. Si quer\u00e9s ver otro producto o retomar la compra despu\u00e9s, aqu\u00ed estoy.";
  }

  return "No hay problema. Si luego quer\u00e9s seguir con la compra o ver otras opciones, te ayudo.";
}
function buildCartSearchInput(item: PendingCartItem): {
  productName: string | null;
  category: string | null;
  color: string | null;
} {
  const nameParts = [item.productName, ...(item.keywords ?? [])].filter(Boolean);

  return {
    productName: nameParts.length > 0 ? nameParts.join(" ") : null,
    category: item.category,
    color: item.color
  };
}

function matchesPendingOperationTarget(
  pendingItem: PendingCartItem,
  targetItem: PendingCartItem
): boolean {
  const pendingCategory = normalizePendingCategoryLabel(pendingItem.category);
  const targetCategory = normalizePendingCategoryLabel(targetItem.category);
  const pendingColor = normalizePendingColorLabel(pendingItem.color);
  const targetColor = normalizePendingColorLabel(targetItem.color);

  if (targetCategory && pendingCategory !== targetCategory) {
    return false;
  }

  if (targetColor && pendingColor !== targetColor) {
    return false;
  }

  const haystack = normalizeInventoryText([
    pendingItem.productName,
    pendingItem.category,
    pendingItem.color,
    ...(pendingItem.keywords ?? [])
  ]);

  if (
    targetItem.productName &&
    !tokenizeInventoryText(targetItem.productName).every((token) =>
      haystack.includes(token)
    )
  ) {
    return false;
  }

  if (
    (targetItem.keywords ?? []).length > 0 &&
    !(targetItem.keywords ?? []).every((keyword) => haystack.includes(keyword))
  ) {
    return false;
  }

  return true;
}

function matchesRequestedCartItem(
  item: InventoryItem,
  requestedItem: PendingCartItem
): boolean {
  const normalizedCategory = normalizeInventoryCategory(item.category);
  const normalizedColor = normalizeInventoryColor(item.color);
  const requestedCategory = normalizeInventoryCategory(requestedItem.category);
  const requestedColor = normalizeInventoryColor(requestedItem.color);

  if (requestedCategory && normalizedCategory !== requestedCategory) {
    return false;
  }

  if (requestedColor && normalizedColor !== requestedColor) {
    return false;
  }

  const haystack = normalizeInventoryText([
    item.name,
    item.category,
    item.color,
    ...(item.keywords ?? []),
    item.description
  ]);

  if (
    requestedItem.productName &&
    !tokenizeInventoryText(requestedItem.productName).every((token) =>
      haystack.includes(token)
    )
  ) {
    return false;
  }

  if (
    (requestedItem.keywords ?? []).length > 0 &&
    !(requestedItem.keywords ?? []).every((keyword) => haystack.includes(keyword))
  ) {
    return false;
  }

  return true;
}

function mergePendingItem(
  pendingItem: PendingCartItem,
  extractedItem: PurchaseItemInput | undefined,
  classification: IntentClassification
): PendingCartItem {
  const shouldIgnoreContextualFields = classification.refersToPreviousProduct;

  return {
    productName:
      extractedItem?.productName ??
      (shouldIgnoreContextualFields ? null : classification.productName) ??
      pendingItem.productName,
    category:
      extractedItem?.category ??
      (shouldIgnoreContextualFields ? null : classification.category) ??
      pendingItem.category,
    color:
      extractedItem?.color ??
      (shouldIgnoreContextualFields ? null : classification.color) ??
      pendingItem.color,
    quantity: classification.quantity ?? pendingItem.quantity,
    keywords: [
      ...new Set([...(pendingItem.keywords ?? []), ...(extractedItem?.keywords ?? [])])
    ]
  };
}

function buildPartialCartClarificationReply(
  resolvedItems: CheckoutCartItem[],
  pendingItem: PendingCartItem
): string {
  const resolvedSummary =
    resolvedItems.length > 0
      ? `Tengo listo ${formatCartItemsInline(resolvedItems)}. `
      : "";

  return `${resolvedSummary}Solo me falta confirmar ${describePendingCartItem(pendingItem)} para seguir con la compra.`;
}

function buildCartReferenceReply(item: CheckoutCartItem): string {
  return `Perfecto, tomo como referencia ${formatFocusedCartItem(item)}. Si quer\u00e9s, le ajusto cantidad o seguimos con tu pedido \ud83d\ude4c`;
}

function buildCartReferenceClarificationReply(
  items: CheckoutCartItem[]
): string {
  const names = items.map((item) => item.productName).join(", ");
  return `Quiero asegurarme de tomar el producto correcto del carrito. \u00bfTe refer\u00eds a ${names}?`;
}

function buildMultiItemCheckoutReply(items: CheckoutCartItem[]): string {
  return buildCartSummaryReply(
    "Perfecto, tengo:",
    items,
    "Para avanzar con tu compra, compartime tu nombre, direcci\u00f3n de entrega y m\u00e9todo de pago preferido \ud83d\ude4c"
  );
}

function buildCartUpdatedReply(
  cartItems: CheckoutCartItem[],
  addedItems: CheckoutCartItem[]
): string {
  const addedLabel =
    addedItems.length === 1
      ? `Perfecto, agregu\u00e9 ${addedItems[0].quantity} ${formatCartItemLabel(addedItems[0])} a tu pedido.`
      : "Perfecto, agregu\u00e9 esos productos a tu pedido.";

  return buildCartSummaryReply(
    `${addedLabel}\nAhora tu carrito lleva:`,
    cartItems,
    "Para seguir, compartime tu nombre, direcci\u00f3n de entrega y m\u00e9todo de pago preferido \ud83d\ude4c"
  );
}

function buildCartModifiedReply(items: CheckoutCartItem[]): string {
  return buildCartSummaryReply(
    "Perfecto, actualic\u00e9 tu pedido.\nAhora tu carrito lleva:",
    items,
    "Si quer\u00e9s, seguimos con tus datos para finalizar la compra \ud83d\ude4c"
  );
}

function buildResumeCartReply(items: CheckoutCartItem[]): string {
  return buildCartSummaryReply(
    "Perfecto, retomemos tu pedido:",
    items,
    "Para seguir, compartime tu nombre, direcci\u00f3n de entrega y m\u00e9todo de pago preferido \ud83d\ude4c"
  );
}

function buildCartOperationClarificationReply(
  cartItems: CheckoutCartItem[],
  pendingItem: PendingCartItem,
  operation: CartOperation["operation"]
): string {
  const operationLabel =
    operation === "remove_item"
      ? "quitar"
      : operation === "update_quantity"
        ? "actualizar"
        : operation === "replace_item"
          ? "cambiar"
          : "agregar";
  const cartSummary =
    cartItems.length > 0
      ? `Tu carrito actual lleva ${formatCartItemsInline(cartItems)}. `
      : "";

  return `${cartSummary}Solo me falta confirmar ${describePendingCartItem(pendingItem)} para ${operationLabel}lo bien en tu pedido.`;
}

function buildCartSummaryReply(
  intro: string,
  items: CheckoutCartItem[],
  outro: string
): string {
  const lines = items
    .map((item) => `- ${item.quantity} ${formatCartItemLabel(item)} - ${formatCartItemPrice(item)}`)
    .join("\n");
  const subtotal = calculateCartSubtotal(items);
  const currency = items[0]?.currency ?? "HNL";

  return `${intro}\n${lines}\nSubtotal estimado: ${subtotal} ${currency}.\n${outro}`;
}

function formatCartItemsInline(items: CheckoutCartItem[]): string {
  return items
    .map((item) => `${item.quantity} ${formatCartItemLabel(item)}`)
    .join(", ");
}

function formatCartItemLabel(item: CheckoutCartItem): string {
  if (item.quantity > 1) {
    return pluralizeProductName(item.productName.toLowerCase());
  }

  return item.productName.toLowerCase();
}

function formatFocusedCartItem(item: CheckoutCartItem): string {
  return item.quantity > 1
    ? `${item.productName.toLowerCase()} (${item.quantity} unidades)`
    : item.productName.toLowerCase();
}

function formatCartItemPrice(item: CheckoutCartItem): string {
  if (item.quantity > 1) {
    return `${item.unitPrice} ${item.currency} c/u`;
  }

  return `${item.unitPrice} ${item.currency}`;
}

function calculateCartSubtotal(items: CheckoutCartItem[]): number {
  return items.reduce((total, item) => total + item.subtotal, 0);
}

function removeCartItemQuantity(
  cartItems: CheckoutCartItem[],
  targetCartItem: CheckoutCartItem,
  quantity: number | null
): CheckoutCartItem[] {
  return cartItems.flatMap((cartItem) => {
    if (cartItem.productId !== targetCartItem.productId) {
      return [{ ...cartItem }];
    }

    if (quantity === null || quantity >= cartItem.quantity) {
      return [];
    }

    const nextQuantity = cartItem.quantity - quantity;
    return [
      {
        ...cartItem,
        quantity: nextQuantity,
        subtotal: nextQuantity * cartItem.unitPrice
      }
    ];
  });
}

function removeCartItemGroup(
  cartItems: CheckoutCartItem[],
  targetCartItems: CheckoutCartItem[]
): CheckoutCartItem[] {
  const targetIds = new Set(targetCartItems.map((item) => item.productId));

  return cartItems
    .filter((item) => !targetIds.has(item.productId))
    .map((item) => ({ ...item }));
}

function removePendingItemQuantity(
  pendingItems: PendingCartItem[],
  targetPendingItem: PendingCartItem,
  quantity: number | null
): PendingCartItem[] {
  return pendingItems.flatMap((pendingItem) => {
    if (pendingItem !== targetPendingItem) {
      return [{ ...pendingItem, keywords: [...(pendingItem.keywords ?? [])] }];
    }

    if (quantity === null || quantity >= pendingItem.quantity) {
      return [];
    }

    return [
      {
        ...pendingItem,
        quantity: pendingItem.quantity - quantity,
        keywords: [...(pendingItem.keywords ?? [])]
      }
    ];
  });
}

function updateCartItemQuantity(
  cartItems: CheckoutCartItem[],
  targetCartItem: CheckoutCartItem,
  quantity: number
): CheckoutCartItem[] {
  return cartItems.flatMap((cartItem) => {
    if (cartItem.productId !== targetCartItem.productId) {
      return [{ ...cartItem }];
    }

    if (quantity <= 0) {
      return [];
    }

    return [
      {
        ...cartItem,
        quantity,
        subtotal: quantity * cartItem.unitPrice
      }
    ];
  });
}

function updatePendingItemQuantity(
  pendingItems: PendingCartItem[],
  targetPendingItem: PendingCartItem,
  quantity: number
): PendingCartItem[] {
  return pendingItems.flatMap((pendingItem) => {
    if (pendingItem !== targetPendingItem) {
      return [{ ...pendingItem, keywords: [...(pendingItem.keywords ?? [])] }];
    }

    if (quantity <= 0) {
      return [];
    }

    return [
      {
        ...pendingItem,
        quantity,
        keywords: [...(pendingItem.keywords ?? [])]
      }
    ];
  });
}

function mergeCheckoutCartItems(
  existingItems: CheckoutCartItem[],
  newItems: CheckoutCartItem[]
): CheckoutCartItem[] {
  const mergedItems = existingItems.map((item) => ({ ...item }));

  for (const newItem of newItems) {
    const existingItem = mergedItems.find(
      (item) => item.productId === newItem.productId
    );

    if (existingItem) {
      existingItem.quantity += newItem.quantity;
      existingItem.subtotal = existingItem.quantity * existingItem.unitPrice;
      continue;
    }

    mergedItems.push({ ...newItem });
  }

  return mergedItems;
}

function shouldRemoveMatchedGroup(operation: CartOperation): boolean {
  return Boolean(
    operation.operation === "remove_item" &&
      operation.quantity === null &&
      operation.category &&
      !operation.color &&
      !operation.productName
  );
}

function describePendingCartItem(item: PendingCartItem): string {
  const parts = buildPendingItemLabelParts(item);

  if (parts.length > 0) {
    return `cual ${parts.join(" ")} queres`;
  }

  if (item.productName) {
    return `a cual producto te referis con "${item.productName}"`;
  }

  return "que producto te interesa";
}

function pluralizeProductName(productName: string): string {
  const tokens = productName.split(" ");

  if (tokens[0] === "camiseta") {
    tokens[0] = "camisetas";
  } else if (tokens[0] === "gorra") {
    tokens[0] = "gorras";
  } else if (tokens[0] === "hoodie") {
    tokens[0] = "hoodies";
  } else if (tokens[0] === "jogger") {
    tokens[0] = "joggers";
  }

  if (tokens[1] === "negra") {
    tokens[1] = "negras";
  } else if (tokens[1] === "blanca") {
    tokens[1] = "blancas";
  } else if (tokens[1] === "negro") {
    tokens[1] = "negros";
  } else if (tokens[1] === "blanco") {
    tokens[1] = "blancos";
  } else if (tokens[1] === "gris") {
    tokens[1] = "grises";
  }

  return tokens.join(" ");
}

function buildPendingItemLabelParts(item: PendingCartItem): string[] {
  const category = normalizePendingCategoryLabel(item.category);
  const color = normalizePendingColorLabel(item.color);
  const keywords = (item.keywords ?? []).filter(
    (keyword) => keyword !== category && keyword !== color
  );

  return [
    ...new Set(
      [category, color, ...keywords].filter((value): value is string => Boolean(value))
    )
  ];
}

function normalizePendingCategoryLabel(category: string | null | undefined): string | null {
  if (!category) {
    return null;
  }

  const aliases: Record<string, string | null> = {
    hoodie: "hoodie",
    jogger: "jogger",
    camiseta: "camiseta",
    camisa: "camiseta",
    camisas: "camiseta",
    playera: "camiseta",
    playeras: "camiseta",
    accessory: "gorra",
    accessories: "gorra",
    accesorio: "gorra",
    accesorios: "gorra",
    gorra: "gorra",
    short: "short",
    polo: "polo",
    clothing: null,
    ropa: null
  };

  return aliases[category] ?? category;
}

function normalizePendingColorLabel(color: string | null | undefined): string | null {
  if (!color) {
    return null;
  }

  const aliases: Record<string, string> = {
    negra: "negro",
    blanco: "blanco",
    blanca: "blanco",
    roja: "rojo"
  };

  return aliases[color] ?? color;
}

function normalizeInventoryCategory(category: string | null | undefined): string {
  return normalizeInventoryText([category]).trim();
}

function normalizeInventoryColor(color: string | null | undefined): string {
  const normalized = normalizeInventoryText([color]).trim();

  if (normalized === "negra") {
    return "negro";
  }

  if (normalized === "blanca") {
    return "blanco";
  }

  if (normalized === "roja") {
    return "rojo";
  }

  return normalized;
}

function tokenizeInventoryText(value: string): string[] {
  return normalizeInventoryText([value])
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeInventoryText(values: Array<string | null | undefined>): string {
  return values
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResumeMessage(message: string): string {
  return message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
