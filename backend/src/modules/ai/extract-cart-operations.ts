import { openAiClient } from "../../services/openai/openai.client";
import { PurchaseItemInput } from "./extract-purchase-items";

export type CartOperationType =
  | "add_item"
  | "remove_item"
  | "update_quantity"
  | "replace_item";

export type CartOperation = {
  operation: CartOperationType;
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number | null;
  keywords: string[];
  replacementItem: PurchaseItemInput | null;
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
            enum: ["add_item", "remove_item", "update_quantity", "replace_item"]
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
          }
        },
        required: [
          "operation",
          "productName",
          "category",
          "color",
          "quantity",
          "keywords",
          "replacementItem"
        ]
      }
    }
  },
  required: ["operations"]
} as const;

export async function extractCartOperations(
  message: string
): Promise<CartOperation[]> {
  if (!openAiClient.isConfigured()) {
    return fallbackExtractCartOperations(message);
  }

  try {
    const output =
      await openAiClient.generateStructuredOutput<CartOperationsExtraction>({
        instructions: [
          "Extrae operaciones de carrito desde mensajes de compra en espanol conversacional.",
          "Devuelve solo JSON valido.",
          "Usa add_item, remove_item, update_quantity o replace_item.",
          "Entiende frases como agregame otra, quitame uno, dejame solo uno, cambialo por otro y sabes que mejor.",
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

    return sanitizeOperations(output.operations);
  } catch {
    return fallbackExtractCartOperations(message);
  }
}

function fallbackExtractCartOperations(message: string): CartOperation[] {
  const normalizedMessage = normalize(message);

  if (!looksLikeCartOperationMessage(normalizedMessage)) {
    return [];
  }

  const replaceMatch = normalizedMessage.match(
    /(?:cambiame|cambia|cambialo|cambiala|cambiala|cambiala|cambiá)\s+(.+?)\s+por\s+(.+)/
  );

  if (replaceMatch) {
    const targetItem = parseItemPart(replaceMatch[1]);
    const replacementItem = parseItemPart(replaceMatch[2]);

    return sanitizeOperations([
      {
        operation: "replace_item",
        productName: targetItem.productName,
        category: targetItem.category,
        color: targetItem.color,
        quantity: targetItem.quantity,
        keywords: targetItem.keywords,
        replacementItem
      }
    ]);
  }

  return sanitizeOperations(
    splitCartOperationParts(normalizedMessage)
      .map((part) => parseCartOperationPart(part))
      .filter((operation): operation is CartOperation => Boolean(operation))
  );
}

function parseCartOperationPart(part: string): CartOperation | null {
  const operation = detectOperation(part);

  if (!operation) {
    return null;
  }

  const item = parseItemPart(part);

  if (
    !item.productName &&
    !item.category &&
    !item.color &&
    item.keywords.length === 0
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
    replacementItem: null
  };
}

function sanitizeOperations(operations: CartOperation[]): CartOperation[] {
  return operations
    .map((operation) => ({
      operation: operation.operation,
      productName: sanitizeItem(operation).productName,
      category: sanitizeItem(operation).category,
      color: sanitizeItem(operation).color,
      quantity: sanitizeQuantity(operation),
      keywords: sanitizeItem(operation).keywords,
      replacementItem: operation.replacementItem
        ? sanitizePurchaseItem(operation.replacementItem)
        : null
    }))
    .filter(
      (operation) =>
        operation.replacementItem !== null ||
        operation.productName ||
        operation.category ||
        operation.color ||
        operation.keywords.length > 0
    );
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
  if (
    part.includes("quitame") ||
    part.includes("quitá") ||
    part.includes("quita") ||
    part.includes("sacame") ||
    part.includes("saca")
  ) {
    return "remove_item";
  }

  if (
    part.includes("dejame solo") ||
    part.includes("deja solo") ||
    part.includes("solo quiero") ||
    part.includes("dejalo en") ||
    part.includes("dejala en")
  ) {
    return "update_quantity";
  }

  if (
    part.includes("cambiame") ||
    part.includes("cambiá") ||
    part.includes("cambia")
  ) {
    return "replace_item";
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

function looksLikeCartOperationMessage(message: string): boolean {
  return (
    message.includes("sabes que") ||
    message.includes("sabes que") ||
    message.includes("mejor") ||
    message.includes("agreg") ||
    message.includes("sumale") ||
    message.includes("quita") ||
    message.includes("quitame") ||
    message.includes("quitá") ||
    message.includes("dejame solo") ||
    message.includes("solo quiero") ||
    message.includes("cambia") ||
    message.includes("cambiame") ||
    message.includes("cambiá")
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
    if (normalized.includes(word)) {
      return value;
    }
  }

  return null;
}

function detectCategory(message: string): string | null {
  const normalized = normalize(message);

  return (
    Object.entries(CATEGORY_ALIASES).find(([alias]) => normalized.includes(alias))?.[1] ??
    null
  );
}

function detectColor(message: string): string | null {
  const normalized = normalize(message);

  return (
    Object.entries(COLOR_ALIASES).find(([alias]) => normalized.includes(alias))?.[1] ??
    null
  );
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
  "agrega",
  "agregale",
  "sumale",
  "suma",
  "quitame",
  "quita",
  "quitá",
  "sacame",
  "saca",
  "dejame",
  "deja",
  "solo",
  "quiero",
  "dame",
  "ahora",
  "porfa",
  "mejor",
  "sabes",
  "que",
  "por"
];
