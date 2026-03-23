import { openAiClient } from "../../services/openai/openai.client";
import { PurchaseItemInput } from "./extract-purchase-items";

export type CartOperationType =
  | "add_item"
  | "remove_item"
  | "update_quantity"
  | "replace_item"
  | "keep_only_item";

export type CartOperation = {
  operation: CartOperationType;
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number | null;
  keywords: string[];
  replacementItem: PurchaseItemInput | null;
  useContextTarget: boolean;
  refersToOthers: boolean;
};

type CartOperationsExtraction = {
  operations: CartOperation[];
};

const cartOperationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: [
              "add_item",
              "remove_item",
              "update_quantity",
              "replace_item",
              "keep_only_item"
            ]
          },
          productName: {
            type: ["string", "null"]
          },
          category: {
            type: ["string", "null"]
          },
          color: {
            type: ["string", "null"]
          },
          quantity: {
            type: ["number", "null"]
          },
          keywords: {
            type: "array",
            items: {
              type: "string"
            }
          },
          replacementItem: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              productName: {
                type: ["string", "null"]
              },
              category: {
                type: ["string", "null"]
              },
              color: {
                type: ["string", "null"]
              },
              quantity: {
                type: "number"
              },
              keywords: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            },
            required: ["productName", "category", "color", "quantity", "keywords"]
          },
          useContextTarget: {
            type: "boolean"
          },
          refersToOthers: {
            type: "boolean"
          }
        },
        required: [
          "operation",
          "productName",
          "category",
          "color",
          "quantity",
          "keywords",
          "replacementItem",
          "useContextTarget",
          "refersToOthers"
        ]
      }
    }
  },
  required: ["operations"]
} as const;

export async function extractCartOperations(
  message: string
): Promise<CartOperation[]> {
  const fallbackOperations = fallbackExtractCartOperations(message);
  const normalizedMessage = normalize(message);

  if (!hasExplicitCartOperationLanguage(normalizedMessage)) {
    return fallbackOperations;
  }

  if (!openAiClient.isConfigured()) {
    return fallbackOperations;
  }

  try {
    const output =
      await openAiClient.generateStructuredOutput<CartOperationsExtraction>({
        instructions: [
          "Extrae operaciones de carrito desde mensajes de compra en espanol conversacional.",
          "Devuelve solo JSON valido.",
          "Usa add_item, remove_item, update_quantity, replace_item o keep_only_item.",
          "Usa keep_only_item para frases como ya solo quiero una gorra negra, dejame solo un jogger o solo quiero esta.",
          "Activa useContextTarget cuando el mensaje depende del contexto del carrito, por ejemplo solo una, esa, la otra, las otras o quitalas.",
          "Activa refersToOthers cuando el mensaje habla de las otras, los otros o lo demas.",
          "Extrae category, color, quantity, productName y keywords utiles como oversize o classic.",
          "Si no se menciona cantidad y la operacion es add_item, usa 1.",
          "Si no se menciona cantidad y la operacion es remove_item, usa null para indicar quitar el item completo.",
          "Para replace_item, usa replacementItem con el nuevo producto.",
          "No inventes operaciones si el mensaje no modifica el carrito."
        ].join(" "),
        input: `Mensaje del cliente: ${message}`,
        schemaName: "cart_operations_extraction",
        schema: cartOperationSchema
      });

    return keepMentionedOperationKeywords(
      mergeCartOperations(sanitizeOperations(output.operations), fallbackOperations),
      message
    );
  } catch {
    return fallbackOperations;
  }
}

function fallbackExtractCartOperations(message: string): CartOperation[] {
  const normalizedMessage = normalizeWithDelimiters(message);

  if (!looksLikeCartOperationMessage(normalizedMessage)) {
    return [];
  }

  return sanitizeOperations(
    splitCartOperationParts(normalizedMessage)
      .map((part) => parseCartOperationPart(part))
      .filter((operation): operation is CartOperation => Boolean(operation))
  );
}

function parseCartOperationPart(part: string): CartOperation | null {
  const replaceMatch = part.match(
    /(?:cambiame|cambia|cambialo|cambiala|cambia la|cambia el|cambia las|cambia los)\s+(.+?)\s+por\s+(.+)/
  );

  if (replaceMatch) {
    const targetItem = parseItemPart(replaceMatch[1]);
    const replacementItem = parseItemPart(replaceMatch[2]);

    return {
      operation: "replace_item",
      productName: targetItem.productName,
      category: targetItem.category,
      color: targetItem.color,
      quantity: targetItem.quantity,
      keywords: targetItem.keywords,
      replacementItem,
      useContextTarget: shouldUseContextTarget(part, targetItem),
      refersToOthers: false
    };
  }

  const operation = detectOperation(part);

  if (!operation) {
    return null;
  }

  const item = parseItemPart(part);
  const useContextTarget = shouldUseContextTarget(part, item);
  const refersToOthers = mentionsOtherItems(part);

  if (
    !item.productName &&
    !item.category &&
    !item.color &&
    item.keywords.length === 0 &&
    !useContextTarget
  ) {
    return null;
  }

  return {
    operation,
    productName: item.productName,
    category: item.category,
    color: item.color,
    quantity:
      operation === "remove_item" && !hasExplicitQuantity(part)
        ? null
        : item.quantity,
    keywords: item.keywords,
    replacementItem: null,
    useContextTarget,
    refersToOthers
  };
}

function sanitizeOperations(operations: CartOperation[]): CartOperation[] {
  return operations
    .map((operation) => {
      const sanitizedItem = sanitizeItem(operation);

      return {
        operation: operation.operation,
        productName: sanitizedItem.productName,
        category: sanitizedItem.category,
        color: sanitizedItem.color,
        quantity: sanitizeQuantity(operation),
        keywords: sanitizedItem.keywords,
        replacementItem: operation.replacementItem
          ? sanitizePurchaseItem(operation.replacementItem)
          : null,
        useContextTarget: Boolean(operation.useContextTarget),
        refersToOthers: Boolean(operation.refersToOthers)
      };
    })
    .filter(
      (operation) =>
        operation.replacementItem !== null ||
        operation.productName ||
        operation.category ||
        operation.color ||
        operation.keywords.length > 0 ||
        operation.useContextTarget
    );
}

function mergeCartOperations(
  primaryOperations: CartOperation[],
  fallbackOperations: CartOperation[]
): CartOperation[] {
  const mergedOperations: CartOperation[] = [];
  const maxLength = Math.max(primaryOperations.length, fallbackOperations.length);

  for (let index = 0; index < maxLength; index += 1) {
    const primaryOperation = primaryOperations[index];
    const fallbackOperation = fallbackOperations[index];

    if (!primaryOperation && fallbackOperation) {
      mergedOperations.push(fallbackOperation);
      continue;
    }

    if (!primaryOperation) {
      continue;
    }

    if (!fallbackOperation) {
      mergedOperations.push(primaryOperation);
      continue;
    }

    mergedOperations.push({
      operation: resolveMergedOperation(primaryOperation, fallbackOperation),
      productName: primaryOperation.productName ?? fallbackOperation.productName,
      category: primaryOperation.category ?? fallbackOperation.category,
      color: primaryOperation.color ?? fallbackOperation.color,
      quantity: primaryOperation.quantity ?? fallbackOperation.quantity,
      keywords: [
        ...new Set([
          ...(primaryOperation.keywords ?? []),
          ...(fallbackOperation.keywords ?? [])
        ])
      ],
      replacementItem:
        primaryOperation.replacementItem ?? fallbackOperation.replacementItem,
      useContextTarget:
        primaryOperation.useContextTarget || fallbackOperation.useContextTarget,
      refersToOthers:
        primaryOperation.refersToOthers || fallbackOperation.refersToOthers
    });
  }

  return sanitizeOperations(mergedOperations);
}

function keepMentionedOperationKeywords(
  operations: CartOperation[],
  message: string
): CartOperation[] {
  const normalizedMessage = normalize(message);

  return operations.map((operation) => ({
    ...operation,
    keywords: (operation.keywords ?? []).filter((keyword) =>
      normalizedMessage.includes(normalize(keyword))
    ),
    replacementItem: operation.replacementItem
      ? {
          ...operation.replacementItem,
          keywords: (operation.replacementItem.keywords ?? []).filter((keyword) =>
            normalizedMessage.includes(normalize(keyword))
          )
        }
      : null
  }));
}

function sanitizeItem(operation: {
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number | null;
  keywords: string[];
}): PurchaseItemInput {
  return sanitizePurchaseItem({
    productName: operation.productName,
    category: operation.category,
    color: operation.color,
    quantity: operation.quantity ?? 1,
    keywords: operation.keywords
  });
}

function sanitizePurchaseItem(item: PurchaseItemInput): PurchaseItemInput {
  const category = normalizeCategory(item.category);
  const color = normalizeColor(item.color);
  const productName = item.productName?.trim() || null;
  const keywords = [...new Set((item.keywords ?? []).map(normalize).filter(Boolean))].filter(
    (keyword) => keyword !== category && keyword !== color
  );

  return {
    productName: productName && normalize(productName) === category ? null : productName,
    category,
    color,
    quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
    keywords
  };
}

function sanitizeQuantity(operation: CartOperation): number | null {
  if (operation.quantity === null) {
    return null;
  }

  if (operation.operation === "remove_item" && operation.quantity === undefined) {
    return null;
  }

  return operation.quantity && operation.quantity > 0 ? operation.quantity : 1;
}

function splitCartOperationParts(message: string): string[] {
  return message
    .split(/\s+y\s+|,/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseItemPart(part: string): PurchaseItemInput {
  const quantity = detectQuantity(part) ?? 1;
  const category = detectCategory(part);
  const color = detectColor(part);
  const keywords = detectKeywords(part);
  const productName = buildProductNameHint(part, { category, color, keywords });

  return {
    productName,
    category,
    color,
    quantity,
    keywords
  };
}

function detectOperation(part: string): CartOperationType | null {
  const item = parseItemPart(part);

  if (looksLikeExplicitKeepOnlyPhrase(part)) {
    return "keep_only_item";
  }

  if (looksLikeQuantityAdjustmentPhrase(part, item)) {
    return "update_quantity";
  }

  if (
    part.includes("quitame") ||
    part.includes("quita") ||
    part.includes("sacame") ||
    part.includes("saca") ||
    part.includes("ya no quiero")
  ) {
    return "remove_item";
  }

  if (part.includes("dejalo en") || part.includes("dejala en")) {
    return "update_quantity";
  }

  if (
    part.includes("agreg") ||
    part.includes("sumale") ||
    part.includes("suma") ||
    part.includes("dame") ||
    part.includes("quiero") ||
    part.includes("ahora") ||
    part.includes("otra") ||
    part.includes("otro")
  ) {
    return "add_item";
  }

  return null;
}

function resolveMergedOperation(
  primaryOperation: CartOperation,
  fallbackOperation: CartOperation
): CartOperationType {
  if (
    primaryOperation.operation === "keep_only_item" &&
    fallbackOperation.operation === "update_quantity"
  ) {
    return "update_quantity";
  }

  if (
    primaryOperation.operation === "update_quantity" &&
    fallbackOperation.operation === "keep_only_item"
  ) {
    return "update_quantity";
  }

  return primaryOperation.operation ?? fallbackOperation.operation;
}

function looksLikeExplicitKeepOnlyPhrase(part: string): boolean {
  return (
    part.includes("quita todo menos") ||
    part.includes("quiero unicamente") ||
    part.includes("quiero solo la") ||
    part.includes("quiero solo el") ||
    part.includes("dejame unicamente") ||
    part.includes("dejame esa") ||
    part.includes("dejame ese") ||
    part.includes("dejame esta") ||
    part.includes("dejame esto") ||
    part.includes("dejame nada mas") ||
    part.includes("dejame nomas") ||
    /(?:solo quiero|ya solo quiero|dejame solo)\s+(?:la|el|esa|ese|esto)\b/.test(part)
  );
}

function looksLikeQuantityAdjustmentPhrase(
  part: string,
  item: PurchaseItemInput
): boolean {
  const hasTarget = Boolean(
    item.productName || item.category || item.color || item.keywords.length > 0
  );

  if (!hasTarget || !hasExplicitQuantity(part)) {
    return false;
  }

  return (
    part.includes("solo quiero") ||
    part.includes("ya solo quiero") ||
    part.includes("quiero solo") ||
    part.includes("quiero solo") ||
    part.includes("dejame ") ||
    part.includes("quiero ")
  );
}

function looksLikeCartOperationMessage(message: string): boolean {
  return (
    message.includes("sabes que") ||
    message.includes("mejor") ||
    message.includes("agreg") ||
    message.includes("sumale") ||
    message.includes("quita") ||
    message.includes("quitame") ||
    message.includes("dejame solo") ||
    message.includes("solo quiero") ||
    message.includes("ya solo quiero") ||
    message.includes("quiero solo") ||
    message.includes("unicamente") ||
    message.includes("todo menos") ||
    message.includes("cambia") ||
    message.includes("cambiame") ||
    message.includes("ya no quiero")
  );
}

function shouldUseContextTarget(
  part: string,
  item: PurchaseItemInput
): boolean {
  if (item.productName || item.category || item.color || item.keywords.length > 0) {
    return false;
  }

  return (
    part.includes("solo una") ||
    part.includes("solo uno") ||
    part.includes("esa") ||
    part.includes("ese") ||
    part.includes("eso") ||
    part.includes("la otra") ||
    part.includes("las otras") ||
    part.includes("los otros") ||
    part.includes("lo otro")
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
    message.includes("quiero solo") ||
    message.includes("dejame") ||
    message.includes("unicamente") ||
    message.includes("todo menos") ||
    message.includes("cambia") ||
    message.includes("cambiame")
  );
}

function mentionsOtherItems(part: string): boolean {
  return (
    part.includes("la otra") ||
    part.includes("el otro") ||
    part.includes("las otras") ||
    part.includes("los otros") ||
    part.includes("lo otro") ||
    part.includes("los demas") ||
    part.includes("las demas")
  );
}

function hasExplicitQuantity(message: string): boolean {
  const normalized = normalize(message);

  return /\b\d+\b/.test(normalized) || NUMBER_WORDS.some((word) => normalized.includes(word));
}

function buildProductNameHint(
  part: string,
  context: {
    category: string | null;
    color: string | null;
    keywords: string[];
  }
): string | null {
  const tokensToRemove = new Set<string>([
    ...NUMBER_WORDS,
    ...Object.keys(CATEGORY_ALIASES),
    ...Object.keys(COLOR_ALIASES),
    ...OPERATION_WORDS,
    ...context.keywords
  ]);
  const remainingTokens = normalize(part)
    .split(" ")
    .filter((token) => token.length > 0 && !tokensToRemove.has(token));
  const cleanedHint = remainingTokens.join(" ").trim();

  return cleanedHint.length > 0 ? cleanedHint : null;
}

function detectQuantity(message: string): number | null {
  const normalized = normalize(message);
  const digitMatch = normalized.match(/\b(\d+)\b/);

  if (digitMatch) {
    return Number(digitMatch[1]);
  }

  for (const [word, value] of Object.entries(NUMBER_WORD_MAP)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) {
      return value;
    }
  }

  return null;
}

function detectCategory(message: string): string | null {
  const normalized = normalize(message);
  return findEarliestAlias(normalized, CATEGORY_ALIASES);
}

function detectColor(message: string): string | null {
  const normalized = normalize(message);
  return findEarliestAlias(normalized, COLOR_ALIASES);
}

function detectKeywords(message: string): string[] {
  const normalized = normalize(message);
  return SUPPORTED_KEYWORDS.filter((keyword) => normalized.includes(keyword));
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWithDelimiters(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s,]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategory(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalize(value);

  if (
    normalized === "ropa" ||
    normalized === "clothing" ||
    normalized === "clothes" ||
    normalized === "prenda" ||
    normalized === "articulo"
  ) {
    return null;
  }

  return CATEGORY_ALIASES[normalized] ?? normalized;
}

function normalizeColor(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalize(value);
  return COLOR_ALIASES[normalized] ?? normalized;
}

function findEarliestAlias(
  normalizedMessage: string,
  aliases: Record<string, string>
): string | null {
  let bestMatch: { index: number; value: string } | null = null;

  for (const [alias, value] of Object.entries(aliases)) {
    const index = normalizedMessage.indexOf(alias);

    if (index === -1) {
      continue;
    }

    if (!bestMatch || index < bestMatch.index) {
      bestMatch = { index, value };
    }
  }

  return bestMatch?.value ?? null;
}

const NUMBER_WORD_MAP: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  otra: 1,
  otro: 1,
  dos: 2,
  tres: 3,
  cuatro: 4
};

const NUMBER_WORDS = Object.keys(NUMBER_WORD_MAP);

const CATEGORY_ALIASES: Record<string, string> = {
  hoodie: "hoodie",
  hoodies: "hoodie",
  hudi: "hoodie",
  sudadera: "hoodie",
  sudaderas: "hoodie",
  jogger: "jogger",
  joggers: "jogger",
  pantalon: "jogger",
  pantalones: "jogger",
  pants: "jogger",
  camiseta: "camiseta",
  camisetas: "camiseta",
  camisa: "camiseta",
  camisas: "camiseta",
  playera: "camiseta",
  playeras: "camiseta",
  oversize: "camiseta",
  oversized: "camiseta",
  accessory: "gorra",
  accessories: "gorra",
  accesorio: "gorra",
  accesorios: "gorra",
  gorra: "gorra",
  gorras: "gorra",
  polo: "polo",
  polos: "polo",
  short: "short",
  shorts: "short",
  pantaloneta: "short",
  pantalonetas: "short"
};

const COLOR_ALIASES: Record<string, string> = {
  negro: "negro",
  negra: "negro",
  negros: "negro",
  negras: "negro",
  blanco: "blanco",
  blanca: "blanco",
  blancos: "blanco",
  blancas: "blanco",
  gris: "gris",
  grises: "gris",
  beige: "beige",
  rojas: "rojo",
  roja: "rojo",
  rojo: "rojo",
  rojos: "rojo",
  azul: "azul",
  azules: "azul"
};

const SUPPORTED_KEYWORDS = [
  "oversize",
  "oversized",
  "relaxed",
  "slim",
  "classic",
  "essentials",
  "basic",
  "premium"
];

const OPERATION_WORDS = [
  "agregame",
  "agrega",
  "agregale",
  "sumale",
  "suma",
  "quitame",
  "quita",
  "sacame",
  "saca",
  "dejame",
  "solo",
  "quiero",
  "dame",
  "ahora",
  "porfa",
  "mejor",
  "sabes",
  "que",
  "ya",
  "la",
  "el",
  "las",
  "los",
  "otras",
  "otros",
  "por"
];
