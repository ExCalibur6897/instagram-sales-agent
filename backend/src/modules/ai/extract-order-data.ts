import { openAiClient } from "../../services/openai/openai.client";

export type OrderDataExtraction = {
  name: string | null;
  address: string | null;
  paymentMethod: string | null;
  complete: boolean;
};

const orderDataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: ["string", "null"]
    },
    address: {
      type: ["string", "null"]
    },
    paymentMethod: {
      type: ["string", "null"]
    },
    complete: {
      type: "boolean"
    }
  },
  required: ["name", "address", "paymentMethod", "complete"]
} as const;

export async function extractOrderData(
  message: string
): Promise<OrderDataExtraction> {
  if (!openAiClient.isConfigured()) {
    return fallbackExtractOrderData(message);
  }

  try {
    return await openAiClient.generateStructuredOutput<OrderDataExtraction>({
      instructions: [
        "Extrae datos de compra desde un mensaje corto en espanol.",
        "Devuelve solo JSON valido.",
        "Identifica nombre, direccion y metodo de pago.",
        "Si algun dato no esta claro, usa null.",
        "complete debe ser true solo si los tres campos estan presentes."
      ].join(" "),
      input: `Mensaje del cliente: ${message}`,
      schemaName: "order_data_extraction",
      schema: orderDataSchema
    });
  } catch {
    return fallbackExtractOrderData(message);
  }
}

function fallbackExtractOrderData(message: string): OrderDataExtraction {
  const normalized = message.trim();
  const parts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const name = parts[0] ?? null;
  const paymentMethod = detectPaymentMethod(normalized);
  const addressCandidates = parts.slice(1).filter((part) => {
    const candidate = part.toLowerCase();
    return !candidate.includes("transfer") &&
      !candidate.includes("efectivo") &&
      !candidate.includes("tarjeta") &&
      !candidate.includes("cash")
      ? true
      : false;
  });
  const address = addressCandidates[0] ?? null;

  return {
    name,
    address,
    paymentMethod,
    complete: Boolean(name && address && paymentMethod)
  };
}

function detectPaymentMethod(message: string): string | null {
  const normalized = message.toLowerCase();

  if (normalized.includes("transfer")) {
    return "transferencia";
  }

  if (normalized.includes("efectivo")) {
    return "efectivo";
  }

  if (normalized.includes("tarjeta")) {
    return "tarjeta";
  }

  return null;
}
