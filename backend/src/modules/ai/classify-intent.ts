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
  tone: detectTone(message)
});

function extractProductHint(message: string): string | null {
  const normalized = message.trim();

  if (
    detectListRequest(message) ||
    detectFaqIntent(message) !== null ||
    detectCategory(message)
  ) {
    return null;
  }

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
        "Debes entender expresiones informales como man, porfa, la negra, y ropa negra, playera, camisa, sudadera, polo, gorra y pantaloneta.",
        "Si el mensaje es un FAQ de ubicacion, horario, pagos o envios, prioriza ese FAQ aunque exista contexto de compra.",
        "Usa product_search para consultas abiertas de un producto o categoria.",
        "Usa collection_request cuando el usuario pida varias opciones o toda una coleccion.",
        "Solo usa buying_intent si el usuario expresa claramente que quiere comprar, llevar, pedir o apartar algo.",
        "No uses buying_intent para mensajes como me interesa, la negra o ese esta bonito.",
        "Usa refersToPreviousProduct = true si el mensaje depende del contexto reciente para entenderse.",
        "Solo marca refersToPreviousProduct si el mensaje es ambiguo y no aporta informacion nueva mas especifica.",
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
  const normalized = normalize(message);
  const faqIntent = detectFaqIntent(message);

  if (faqIntent) {
    return faqIntent;
  }

  if (
    normalized.includes("compr") ||
    normalized.includes("pedido") ||
    normalized.includes("llevar") ||
    normalized.includes("apart")
  ) {
    return "buying_intent";
  }

  if (normalized.includes("cuanto") || normalized.includes("precio")) {
    return "price_question";
  }

  if (
    normalized.includes("tienen") ||
    normalized.includes("busco") ||
    normalized.includes("dime") ||
    normalized.includes("mostra") ||
    normalized.includes("muestra") ||
    normalized.includes("que ") ||
    detectCategory(message) !== null ||
    detectColor(message) !== null
  ) {
    return detectListRequest(message) ? "collection_request" : "product_search";
  }

  if (
    normalized.includes("hola") ||
    normalized.includes("buenas") ||
    normalized.includes("bro") ||
    normalized.includes("man") ||
    normalized.includes("q ondas")
  ) {
    return "greeting";
  }

  return "unknown";
}

function detectCategory(message: string): string | null {
  const normalized = normalize(message);
  const categoryAliases: Record<string, string> = {
    camiseta: "camiseta",
    camisetas: "camiseta",
    camisa: "camiseta",
    camisas: "camiseta",
    playera: "camiseta",
    playeras: "camiseta",
    hoodie: "hoodie",
    hoodies: "hoodie",
    hudi: "hoodie",
    sudadera: "hoodie",
    sudaderas: "hoodie",
    gorra: "gorra",
    gorras: "gorra",
    jogger: "jogger",
    joggers: "jogger",
    yuger: "jogger",
    yugers: "jogger",
    polo: "polo",
    polos: "polo",
    pantaloneta: "short",
    pantalonetas: "short",
    short: "short",
    shorts: "short",
    ropa: "ropa"
  };

  return (
    Object.entries(categoryAliases).find(([alias]) => normalized.includes(alias))?.[1] ??
    null
  );
}

function detectColor(message: string): string | null {
  const normalized = normalize(message);
  const colors = [
    "negra",
    "negro",
    "blanca",
    "blanco",
    "gris",
    "beige",
    "denim",
    "rojo",
    "roja",
    "azul",
    "navy"
  ];

  return colors.find((color) => normalized.includes(color)) ?? null;
}

function detectQuantity(message: string): number | null {
  const normalized = normalize(message);
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
    if (new RegExp(`\\b${word}\\b`).test(normalized)) {
      return value;
    }
  }

  return null;
}

function detectListRequest(message: string): boolean {
  const normalized = normalize(message);
  return (
    normalized.includes("toda") ||
    normalized.includes("tienen") ||
    normalized.includes("que tienen") ||
    normalized.includes("muestr") ||
    normalized.includes("dime") ||
    normalized.includes("que ")
  );
}

function detectContextReference(message: string): boolean {
  const normalized = normalize(message);
  return (
    normalized.includes("la negra") ||
    normalized.includes("esa") ||
    normalized.includes("ese") ||
    normalized.includes("la otra") ||
    normalized.includes("las otras") ||
    normalized.includes("solo una") ||
    normalized.includes("uno") ||
    normalized.includes("el mismo") ||
    normalized.includes("quiero comprar dos")
  );
}

function detectFaqIntent(
  message: string
): IntentClassification["intent"] | null {
  const normalized = normalize(message);

  if (
    normalized.includes("donde estan") ||
    normalized.includes("ubicacion") ||
    normalized.includes("direccion")
  ) {
    return "faq_location";
  }

  if (
    normalized.includes("horario") ||
    normalized.includes("abren") ||
    normalized.includes("cierran")
  ) {
    return "faq_hours";
  }

  if (
    normalized.includes("pago") ||
    normalized.includes("pagan") ||
    normalized.includes("metodos de pago") ||
    normalized.includes("aceptan tarjeta") ||
    normalized.includes("como se paga")
  ) {
    return "faq_payment";
  }

  if (
    normalized.includes("envio") ||
    normalized.includes("envian") ||
    normalized.includes("delivery")
  ) {
    return "faq_shipping";
  }

  return null;
}

function detectTone(message: string): IntentClassification["tone"] {
  const normalized = normalize(message);

  if (
    normalized.includes("bro") ||
    normalized.includes("man") ||
    normalized.includes("rey") ||
    normalized.includes("porfa")
  ) {
    return "casual";
  }

  if (
    normalized.includes("molesto") ||
    normalized.includes("mal") ||
    normalized.includes("nada que ver")
  ) {
    return "upset";
  }

  return "neutral";
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
