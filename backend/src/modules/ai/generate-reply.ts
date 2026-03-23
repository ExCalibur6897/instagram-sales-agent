import { InventoryItem } from "../../services/inventory/inventory.types";
import { IntentClassification } from "./ai.types";

type GenerateReplyInput = {
  userMessage: string;
  classification: IntentClassification;
  product: InventoryItem | null;
  products?: InventoryItem[];
};

export async function generateReply(
  input: GenerateReplyInput
): Promise<string> {
  return buildReply(input);
}

function buildReply(input: GenerateReplyInput): string {
  const { classification, product } = input;
  const products = input.products ?? [];

  if (classification.intent === "buying_intent" && product) {
    const productLabel = formatProductLabel(product.name);
    const quantityText =
      classification.quantity && classification.quantity > 1
        ? ` de ${classification.quantity} unidades`
        : "";

    return `${productLabel} está disponible por ${product.price} ${product.currency}. Para avanzar con tu compra${quantityText}, compartime tu nombre, dirección de entrega y método de pago preferido 🙌`;
  }

  if (classification.intent === "product_search" && product) {
    const productLabel = formatProductLabel(product.name);
    return `${productLabel} está disponible por ${product.price} ${product.currency}. Si quieres, también te ayudo con disponibilidad o compra.`;
  }

  if (
    (classification.intent === "collection_request" ||
      classification.intent === "product_search") &&
    products.length > 0
  ) {
    return buildProductListReply(products, classification);
  }

  if (
    classification.intent === "product_availability" &&
    !product &&
    products.length > 0
  ) {
    return buildAvailabilityListReply(products, classification);
  }

  if (
    (classification.intent === "price_question" ||
      classification.intent === "product_availability") &&
    product
  ) {
    if (classification.intent === "price_question") {
      return `${product.name} cuesta ${product.price} ${product.currency}. Si quieres, te ayudo a seguir con la compra.`;
    }

    return product.stock > 0
      ? `Sí, ${product.name} está disponible. Nos quedan ${product.stock} unidades.`
      : `En este momento ${product.name} no está disponible. Si quieres, te paso con alguien del equipo.`;
  }

  if (classification.handoff) {
    return "Te paso con alguien del equipo para darte una respuesta precisa.";
  }

  if (!product && products.length === 0) {
    return "No encontré una coincidencia clara. Si quieres, dime el producto, color o categoría y te ayudo.";
  }

  return "Gracias por escribirnos. Si me compartes un poco más, te ayudo.";
}

function buildProductListReply(
  products: InventoryItem[],
  classification: IntentClassification
): string {
  const intro =
    classification.category && classification.color
      ? `Estas son las opciones de ${pluralizeCategory(classification.category)} ${formatColorListLabel(classification.color, classification.category)} que tenemos`
      : classification.color
        ? `Estas son las opciones ${formatColorListLabel(classification.color)} que tenemos`
        : classification.category
          ? `Estas son las opciones de ${pluralizeCategory(classification.category)} que tenemos`
          : "Estas son algunas opciones que tenemos";

  return `${intro}: ${formatProductList(products)}.`;
}

function buildAvailabilityListReply(
  products: InventoryItem[],
  classification: IntentClassification
): string {
  const subject =
    classification.category && classification.color
      ? `Sí, tenemos ${pluralizeCategory(classification.category)} en ${classification.color}`
      : classification.category
        ? `Sí, tenemos ${pluralizeCategory(classification.category)} disponibles`
        : "Sí, tenemos estas opciones disponibles";

  return `${subject}: ${formatProductList(products)}.`;
}

function formatProductList(products: InventoryItem[]): string {
  return products
    .slice(0, 4)
    .map((item) => `${item.name} (${item.price} ${item.currency})`)
    .join(", ");
}

function formatProductLabel(productName: string): string {
  const articleByFirstWord: Record<string, string> = {
    camisa: "La",
    camiseta: "La",
    gorra: "La",
    hoodie: "El",
    jogger: "El",
    cargo: "El",
    polo: "El",
    short: "El"
  };
  const [firstWord] = productName.toLowerCase().split(" ");
  const article = articleByFirstWord[firstWord];

  if (!article) {
    return productName;
  }

  return `${article} ${productName.toLowerCase()}`;
}

function pluralizeCategory(category: string): string {
  if (category.endsWith("s")) {
    return category;
  }

  return `${category}s`;
}

function formatColorListLabel(
  color: string,
  category?: string | null
): string {
  const masculineCategories = new Set([
    "hoodie",
    "jogger",
    "cargo",
    "polo",
    "short"
  ]);
  const useMasculine = category ? masculineCategories.has(category) : false;

  if (color === "negra" || color === "negro") {
    return useMasculine ? "negros" : "negras";
  }

  if (color === "blanca" || color === "blanco") {
    return useMasculine ? "blancos" : "blancas";
  }

  if (color === "roja" || color === "rojo") {
    return useMasculine ? "rojos" : "rojas";
  }

  if (color === "gris") {
    return "grises";
  }

  return color;
}
