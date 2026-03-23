import { openAiClient } from "../../services/openai/openai.client";
import { ConversationMemory } from "../../services/conversation/conversation-memory.service";
import { IntentName, intentOptions } from "./ai.types";

type MultipleIntentOutput = {
  intents: IntentName[];
};

const multiIntentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intents: {
      type: "array",
      items: {
        type: "string",
        enum: [...intentOptions]
      }
    }
  },
  required: ["intents"]
} as const;

export async function extractMessageIntents(
  message: string,
  memory: ConversationMemory
): Promise<IntentName[]> {
  if (!openAiClient.isConfigured()) {
    return fallbackExtractMessageIntents(message);
  }

  try {
    const output =
      await openAiClient.generateStructuredOutput<MultipleIntentOutput>({
        instructions: [
          "Extrae multiples intenciones desde un solo mensaje en espanol conversacional.",
          "Devuelve solo JSON valido.",
          "Puedes devolver varias intenciones si el mensaje mezcla saludo, compra, precio, busqueda o FAQs.",
          "Si detectas compra y FAQ a la vez, incluye ambas.",
          "No inventes intenciones que no aparezcan claramente en el mensaje."
        ].join(" "),
        input: [
          `Mensaje del usuario: ${message}`,
          `Contexto reciente: ${JSON.stringify(memory)}`
        ].join("\n\n"),
        schemaName: "multiple_message_intents",
        schema: multiIntentSchema
      });

    return dedupeIntents(output.intents);
  } catch {
    return fallbackExtractMessageIntents(message);
  }
}

function fallbackExtractMessageIntents(message: string): IntentName[] {
  const normalized = normalize(message);
  const intents: IntentName[] = [];

  if (
    normalized.includes("hola") ||
    normalized.includes("buenas") ||
    normalized.includes("bro") ||
    normalized.includes("man") ||
    normalized.includes("q ondas")
  ) {
    intents.push("greeting");
  }

  if (
    normalized.includes("envio") ||
    normalized.includes("envian") ||
    normalized.includes("delivery")
  ) {
    intents.push("faq_shipping");
  }

  if (
    normalized.includes("pago") ||
    normalized.includes("metodos de pago") ||
    normalized.includes("aceptan tarjeta")
  ) {
    intents.push("faq_payment");
  }

  if (
    normalized.includes("ubicacion") ||
    normalized.includes("direccion") ||
    normalized.includes("donde estan")
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

  if (
    normalized.includes("cuanto vale") ||
    normalized.includes("cuanto cuesta") ||
    normalized.includes("precio") ||
    normalized.includes("cuanto es")
  ) {
    intents.push("price_question");
  }

  if (
    normalized.includes("quiero") ||
    normalized.includes("dame") ||
    normalized.includes("comprar") ||
    normalized.includes("pedido") ||
    normalized.includes("llevar")
  ) {
    intents.push("buying_intent");
  }

  if (
    normalized.includes("tienen") ||
    normalized.includes("busco") ||
    normalized.includes("muestrame")
  ) {
    intents.push("product_search");
  }

  return dedupeIntents(intents);
}

function dedupeIntents(intents: IntentName[]): IntentName[] {
  return [...new Set(intents)].filter((intent) => intent !== "unknown");
}

function normalize(message: string): string {
  return message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
