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

    return `${productLabel} est\u00e1 disponible por ${product.price} ${product.currency}. Para avanzar con tu compra${quantityText}, compartime tu nombre, direcci\u00f3n de entrega y m\u00e9todo de pago preferido \ud83d\ude4c`;
  }

  if (classification.intent === "product_search" && product) {
    const productLabel = formatProductLabel(product.name);
    return `${productLabel} est\u00e1 disponible por ${product.price} ${product.currency}. Si quer\u00e9s, tambi\u00e9n te ayudo con disponibilidad o compra.`;
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
      return `${product.name} cuesta ${product.price} ${product.currency}. Si quer\u00e9s, te ayudo a seguir con la compra.`;
    }

    return product.stock > 0
      ? `S\u00ed, ${product.name} est\u00e1 disponible. Nos quedan ${product.stock} unidades.`
      : `Ahorita ${product.name} no est\u00e1 disponible. Si quer\u00e9s, te paso con alguien del equipo.`;
  }

  if (classification.handoff) {
    return "Te paso con alguien del equipo para darte una respuesta precisa.";
  }

  if (!product && products.length === 0) {
    return "No encontr\u00e9 una coincidencia clara. Decime el producto, color o categor\u00eda y te ayudo.";
  }

  return "Gracias por escribirnos. Si me compart\u00eds un poco m\u00e1s, te ayudo.";
}

function buildProductListReply(
  products: InventoryItem[],
  classification: IntentClassification
): string {
  const intro =
    classification.category && classification.color
      ? `Estas son las opciones de ${pluralizeCategory(classification.category)} ${formatColorListLabel(classification.color, classification.category)} que tenemos`
      : classification.color
        ? `Estas son las prendas ${formatColorListLabel(classification.color)} que tenemos`
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
      ? `S\u00ed, tenemos ${pluralizeCategory(classification.category)} en ${classification.color}`
      : classification.category
        ? `S\u00ed, tenemos ${pluralizeCategory(classification.category)} disponibles`
        : "S\u00ed, tenemos estas opciones disponibles";

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
  const pluralByCategory: Record<string, string> = {
    camiseta: "camisetas",
    hoodie: "hoodies",
    jogger: "joggers",
    gorra: "gorras",
    polo: "polos",
    short: "shorts"
  };

  return pluralByCategory[category] ?? (category.endsWith("s") ? category : `${category}s`);
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
