import { openAiClient } from "../../services/openai/openai.client";
import { ConversationMemory } from "../../services/conversation/conversation-memory.service";
import {
  IntentClassification,
  intentOptions,
  toneOptions
} from "./ai.types";

const classificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: [...intentOptions]
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
    isListRequest: {
      type: "boolean"
    },
    refersToPreviousProduct: {
      type: "boolean"
    },
    handoff: {
      type: "boolean"
    },
    tone: {
      type: "string",
      enum: [...toneOptions]
    }
  },
  required: [
    "intent",
    "productName",
    "category",
    "color",
    "quantity",
    "isListRequest",
    "refersToPreviousProduct",
    "handoff",
    "tone"
  ]
} as const;

const fallbackClassification = (message: string): IntentClassification => ({
  intent: detectFallbackIntent(message),
  productName: extractProductHint(message),
  category: detectCategory(message),
  color: detectColor(message),
  quantity: detectQuantity(message),
  isListRequest: detectListRequest(message),
  refersToPreviousProduct: detectContextReference(message),
  handoff: false,
  tone: "neutral"
});

function extractProductHint(message: string): string | null {
  const normalized = message.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function classifyIntent(
  message: string,
  memory: ConversationMemory
): Promise<IntentClassification> {
  if (!openAiClient.isConfigured()) {
    return fallbackClassification(message);
  }

  try {
    return await openAiClient.generateStructuredOutput<IntentClassification>({
      instructions: [
        "Eres un clasificador de intencion para mensajes de Instagram en espanol conversacional.",
        "Devuelve solo JSON valido con la estructura requerida.",
        "Debes entender expresiones informales como man, porfa, la negra, y referencias al contexto reciente.",
        "Usa product_search para consultas abiertas de un producto o categoria.",
        "Usa collection_request cuando el usuario pida varias opciones o toda una coleccion.",
        "Usa refersToPreviousProduct = true si el mensaje depende del contexto reciente para entenderse.",
        "Usa category y color cuando aparezcan en el mensaje aunque no haya producto exacto.",
        "Extrae quantity si el usuario menciona una cantidad para compra.",
        "Si el mensaje pide hablar con una persona, esta molesto o necesita seguimiento humano, activa handoff.",
        "Usa productName = null si no hay un producto claro."
      ].join(" "),
      input: [
        `Mensaje del usuario: ${message}`,
        `Contexto reciente: ${JSON.stringify(memory)}`
      ].join("\n\n"),
      schemaName: "intent_classification",
      schema: classificationSchema
    });
  } catch {
    return fallbackClassification(message);
  }
}

function detectFallbackIntent(message: string): IntentClassification["intent"] {
  const normalized = message.toLowerCase();

  if (normalized.includes("compr")) {
    return "buying_intent";
  }

  if (
    normalized.includes("tienen") ||
    normalized.includes("busco") ||
    normalized.includes("dime")
  ) {
    return detectListRequest(message) ? "collection_request" : "product_search";
  }

  if (normalized.includes("cuanto") || normalized.includes("precio")) {
    return "price_question";
  }

  return "unknown";
}

function detectCategory(message: string): string | null {
  const normalized = message.toLowerCase();
  const categories = [
    "camiseta",
    "camisa",
    "hoodie",
    "gorra",
    "jogger",
    "cargo",
    "ropa"
  ];

  return (
    categories.find(
      (category) =>
        normalized.includes(category) || normalized.includes(`${category}s`)
    ) ?? null
  );
}

function detectColor(message: string): string | null {
  const normalized = message.toLowerCase();
  const colors = ["negra", "negro", "blanca", "blanco", "gris", "beige", "denim"];

  return colors.find((color) => normalized.includes(color)) ?? null;
}

function detectQuantity(message: string): number | null {
  const normalized = message.toLowerCase();
  const digitMatch = normalized.match(/\b(\d+)\b/);

  if (digitMatch) {
    return Number(digitMatch[1]);
  }

  const numberWords: Record<string, number> = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4
  };

  for (const [word, value] of Object.entries(numberWords)) {
    if (normalized.includes(word)) {
      return value;
    }
  }

  return null;
}

function detectListRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("toda") ||
    normalized.includes("tienen") ||
    normalized.includes("que tienen") ||
    normalized.includes("muestr") ||
    normalized.includes("dime")
  );
}

function detectContextReference(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("la negra") ||
    normalized.includes("esa") ||
    normalized.includes("ese") ||
    normalized.includes("el mismo") ||
    normalized.includes("quiero comprar dos")
  );
}
