import { openAiClient } from "../../services/openai/openai.client";

export type PurchaseItemInput = {
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number;
  keywords: string[];
};

type PurchaseItemsExtraction = {
  items: PurchaseItemInput[];
};

const purchaseItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
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
    }
  },
  required: ["items"]
} as const;

export async function extractPurchaseItems(
  message: string
): Promise<PurchaseItemInput[]> {
  const fallbackItems = fallbackExtractPurchaseItems(message);

  if (!openAiClient.isConfigured()) {
    return fallbackItems;
  }

  try {
    const output =
      await openAiClient.generateStructuredOutput<PurchaseItemsExtraction>({
        instructions: [
          "Extrae multiples productos de compra desde un mensaje en espanol conversacional.",
          "Devuelve solo JSON valido.",
          "Cada item representa un producto distinto dentro del mismo mensaje.",
          "Extrae category, color, quantity, productName y keywords utiles como oversize, slim, relaxed o classic.",
          "Si no hay productName exacto, usa null.",
          "Si no se menciona cantidad, usa 1.",
          "No inventes items que no aparezcan en el mensaje."
        ].join(" "),
        input: `Mensaje del cliente: ${message}`,
        schemaName: "purchase_items_extraction",
        schema: purchaseItemSchema
      });
    const primaryItems = sanitizeExtractedItems(output.items);

    if (fallbackItems.length > 1) {
      return fallbackItems;
    }

    return keepMentionedKeywords(
      mergeExtractedItems(primaryItems, fallbackItems),
      message
    );
  } catch {
    return fallbackItems;
  }
}

function fallbackExtractPurchaseItems(message: string): PurchaseItemInput[] {
  const cleanedMessage = normalizeWithDelimiters(message)
    .replace(/\b(quiero comprar|me interesa comprar|quiero llevar|quiero|llevar|pedir|apartar)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedMessage) {
    return [];
  }

  return sanitizeExtractedItems(
    splitIntoCandidateItems(cleanedMessage)
      .map((part) => stripConversationalNoise(part))
      .filter((part) => Boolean(part))
      .filter((part) => isPotentialPurchasePart(part))
      .map((part) => parseCandidateItem(part))
  );
}

function splitIntoCandidateItems(message: string): string[] {
  return message
    .split(/\s+y\s+|,/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCandidateItem(part: string): PurchaseItemInput {
  const quantity = detectQuantity(part) ?? 1;
  const category = detectCategory(part);
  const color = detectColor(part);
  const keywords = detectKeywords(part);
  const productName = buildProductNameHint(part, { category, color, quantity, keywords });

  return {
    productName,
    category,
    color,
    quantity,
    keywords
  };
}

function sanitizeExtractedItems(items: PurchaseItemInput[]): PurchaseItemInput[] {
  return items
    .map((item) => {
      const rawProductName = item.productName?.trim() || null;
      const inferredCategory = rawProductName ? detectCategory(rawProductName) : null;
      const inferredColor = rawProductName ? detectColor(rawProductName) : null;
      const category = normalizeCategory(inferredCategory ?? item.category);
      const color = normalizeColor(inferredColor ?? item.color);
      const productName = rawProductName;
      const keywords = [...new Set((item.keywords ?? []).map(normalize).filter(Boolean))].filter(
        (keyword) => keyword !== category && keyword !== color
      );

      return {
        productName:
          productName && normalize(productName) === category ? null : productName,
        category,
        color,
        quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
        keywords
      };
    })
    .filter((item) => item.productName || item.category || item.color || item.keywords.length > 0);
}

function mergeExtractedItems(
  primaryItems: PurchaseItemInput[],
  fallbackItems: PurchaseItemInput[]
): PurchaseItemInput[] {
  const mergedItems: PurchaseItemInput[] = [];
  const maxLength = Math.max(primaryItems.length, fallbackItems.length);

  for (let index = 0; index < maxLength; index += 1) {
    const item = primaryItems[index];
    const fallbackItem = fallbackItems[index];

    if (!item && fallbackItem) {
      mergedItems.push(fallbackItem);
      continue;
    }

    if (!item) {
      continue;
    }

    if (!fallbackItem) {
      mergedItems.push(item);
      continue;
    }

    const fallbackCategory = fallbackItem.category;
    const fallbackColor = fallbackItem.color;
    const normalizedProductName = normalize(item.productName);
    const shouldTrustFallbackCategory =
      Boolean(fallbackCategory) &&
      (!item.category ||
        (normalizedProductName.includes(fallbackCategory!) &&
          item.category !== fallbackCategory));
    const category = shouldTrustFallbackCategory
      ? fallbackCategory
      : item.category ?? fallbackCategory;
    const shouldTrustFallbackColor =
      Boolean(fallbackColor) &&
      (!item.color ||
        item.color.includes(" ") ||
        (item.color !== fallbackColor && category === fallbackCategory));
    const color = shouldTrustFallbackColor
      ? fallbackColor
      : item.color ?? fallbackColor;
    const productName =
      item.productName && category && normalize(item.productName) === category
        ? fallbackItem.productName
        : shouldTrustFallbackCategory
          ? fallbackItem.productName ?? item.productName
          : item.productName ?? fallbackItem.productName;

    mergedItems.push({
      productName,
      category,
      color,
      quantity: item.quantity ?? fallbackItem.quantity,
      keywords: [...new Set([...(item.keywords ?? []), ...(fallbackItem.keywords ?? [])])]
    });
  }

  return sanitizeExtractedItems(mergedItems);
}

function keepMentionedKeywords(
  items: PurchaseItemInput[],
  message: string
): PurchaseItemInput[] {
  const normalizedMessage = normalize(message);

  return items.map((item) => ({
    ...item,
    keywords: (item.keywords ?? []).filter((keyword) =>
      normalizedMessage.includes(normalize(keyword))
    )
  }));
}

function buildProductNameHint(
  part: string,
  context: {
    category: string | null;
    color: string | null;
    quantity: number;
    keywords: string[];
  }
): string | null {
  const tokensToRemove = new Set<string>([
    ...NUMBER_WORDS,
    ...Object.keys(CATEGORY_ALIASES),
    ...Object.keys(COLOR_ALIASES),
    ...PURCHASE_FILLER_WORDS,
    ...context.keywords
  ]);
  const rawTokens = normalize(part).split(" ").filter(Boolean);
  const remainingTokens = rawTokens.filter((token) => !tokensToRemove.has(token));
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

function stripConversationalNoise(part: string): string {
  let cleaned = part.trim();

  while (
    /^(?:y|hola|buenas|hey|ey|oye|bro|man|rey|loco|dog|fijate|mira|sabes que)\b\s*/.test(
      cleaned
    )
  ) {
    cleaned = cleaned.replace(
      /^(?:y|hola|buenas|hey|ey|oye|bro|man|rey|loco|dog|fijate|mira|sabes que)\b\s*/,
      ""
    );
  }

  return cleaned
    .replace(/\b(?:porfa|pls|por favor)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPotentialPurchasePart(part: string): boolean {
  if (!part || isFaqOnlyPart(part)) {
    return false;
  }

  const category = detectCategory(part);
  const color = detectColor(part);
  const keywords = detectKeywords(part);
  const quantity = detectQuantity(part);
  const productName = buildProductNameHint(part, {
    category,
    color,
    quantity: quantity ?? 1,
    keywords
  });

  return Boolean(category || color || keywords.length > 0 || productName);
}

function isFaqOnlyPart(part: string): boolean {
  const normalized = normalize(part);

  return (
    normalized.includes("donde estan") ||
    normalized.includes("ubicacion") ||
    normalized.includes("ubicados") ||
    normalized.includes("direccion") ||
    normalized.includes("envio") ||
    normalized.includes("envian") ||
    normalized.includes("delivery") ||
    normalized.includes("metodos de pago") ||
    normalized.includes("pago") ||
    normalized.includes("horario") ||
    normalized.includes("abren") ||
    normalized.includes("cierran")
  );
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
  dos: 2,
  tres: 3,
  cuatro: 4
};

const NUMBER_WORDS = Object.keys(NUMBER_WORD_MAP);

const PURCHASE_FILLER_WORDS = [
  "dame",
  "quiero",
  "llevar",
  "llevarme",
  "comprar",
  "pedir",
  "agregame",
  "sumale"
];

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
  yuger: "jogger",
  yugers: "jogger",
  camiseta: "camiseta",
  camisetas: "camiseta",
  camisa: "camiseta",
  camisas: "camiseta",
  playera: "camiseta",
  playeras: "camiseta",
  oversized: "camiseta",
  oversize: "camiseta",
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
  pantalonetas: "short",
  ropa: "ropa"
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
  azules: "azul",
  navy: "azul"
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
