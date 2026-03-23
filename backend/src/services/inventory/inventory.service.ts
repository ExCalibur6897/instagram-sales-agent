import fs from "fs";
import { paths } from "../../config/paths";
import {
  InventoryItem,
  InventoryMatchResult,
  InventorySearchInput
} from "./inventory.types";

class InventoryService {
  private inventoryCache: InventoryItem[] | null = null;

  getInventory(): InventoryItem[] {
    if (this.inventoryCache) {
      return this.inventoryCache;
    }

    const raw = fs.readFileSync(paths.inventoryFile, "utf-8");
    this.inventoryCache = JSON.parse(raw) as InventoryItem[];
    return this.inventoryCache;
  }

  findById(productId: string): InventoryItem | null {
    return this.getInventory().find((item) => item.id === productId) ?? null;
  }

  findByName(productName: string | null): InventoryItem | null {
    return this.findMatch({ productName }).product;
  }

  findMatch(input: InventorySearchInput | null | undefined): InventoryMatchResult {
    const safeInput = normalizeSearchInput(input);
    const strictResult = this.findStructuredMatches(this.getInventory(), safeInput);

    if (strictResult) {
      return strictResult;
    }

    const scoredItems = this.searchByNameOnly(
      this.getInventory(),
      safeInput.productName
    );

    if (scoredItems.length === 0) {
      return {
        product: null,
        alternatives: [],
        products: [],
        availableColors: []
      };
    }

    const topScore = scoredItems[0].score;
    const strongMatches = scoredItems.filter(
      (entry) => topScore - entry.score <= 10 && entry.score >= 35
    );

    if (strongMatches.length > 1) {
      return {
        product: null,
        alternatives: strongMatches.map((entry) => entry.item).slice(0, 3),
        products: strongMatches.map((entry) => entry.item),
        availableColors: getAvailableColors(strongMatches.map((entry) => entry.item))
      };
    }

    return {
      product: scoredItems[0].item,
      alternatives: [],
      products: scoredItems.map((entry) => entry.item),
      availableColors: getAvailableColors(scoredItems.map((entry) => entry.item))
    };
  }

  findMatchInItems(
    items: InventoryItem[],
    input: InventorySearchInput | null | undefined
  ): InventoryMatchResult {
    const safeInput = normalizeSearchInput(input);
    const strictResult = this.findStructuredMatches(items, safeInput);

    if (strictResult) {
      return strictResult;
    }

    const scoredItems = this.searchByNameOnly(items, safeInput.productName);

    if (scoredItems.length === 0) {
      return {
        product: null,
        alternatives: [],
        products: [],
        availableColors: []
      };
    }

    const topScore = scoredItems[0].score;
    const strongMatches = scoredItems.filter(
      (entry) => topScore - entry.score <= 10 && entry.score >= 35
    );

    if (strongMatches.length > 1) {
      return {
        product: null,
        alternatives: strongMatches.map((entry) => entry.item).slice(0, 3),
        products: strongMatches.map((entry) => entry.item),
        availableColors: getAvailableColors(strongMatches.map((entry) => entry.item))
      };
    }

    return {
      product: scoredItems[0].item,
      alternatives: [],
      products: scoredItems.map((entry) => entry.item),
      availableColors: getAvailableColors(scoredItems.map((entry) => entry.item))
    };
  }

  private findStructuredMatches(
    items: InventoryItem[],
    input: { productName: string; category: string; color: string }
  ): InventoryMatchResult | null {
    const hasCategory = Boolean(input.category);
    const hasColor = Boolean(input.color);

    if (!hasCategory && !hasColor) {
      return null;
    }

    let baseItems = items;

    if (hasCategory) {
      baseItems = baseItems.filter(
        (item) => normalizeCategory(item.category) === input.category
      );
    }

    if (hasColor) {
      const colorFilteredItems = baseItems.filter(
        (item) => normalizeColor(item.color) === input.color
      );

      if (colorFilteredItems.length === 0) {
        return {
          product: null,
          alternatives: [],
          products: [],
          availableColors: getAvailableColors(baseItems)
        };
      }

      baseItems = colorFilteredItems;
    }

    if (input.productName) {
      const scoredItems = baseItems
        .map((item) => ({
          item,
          score: scoreItemByName(item, input.productName)
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

      if (scoredItems.length === 0) {
        return {
          product: null,
          alternatives: [],
          products: [],
          availableColors: getAvailableColors(baseItems)
        };
      }

      return buildRankedResult(scoredItems);
    }

    return buildRankedResult(baseItems.map((item) => ({ item, score: 100 })));
  }

  private searchByNameOnly(
    items: InventoryItem[],
    productName: string
  ): Array<{ item: InventoryItem; score: number }> {
    if (!productName) {
      return [];
    }

    return items
      .map((item) => ({
        item,
        score: scoreItemByName(item, productName)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
  }
}

function buildRankedResult(
  entries: Array<{ item: InventoryItem; score: number }>
): InventoryMatchResult {
  if (entries.length === 0) {
    return {
      product: null,
      alternatives: [],
      products: [],
      availableColors: []
    };
  }

  const sortedEntries = [...entries].sort((left, right) => right.score - left.score);

  if (sortedEntries.length > 1) {
    return {
      product: null,
      alternatives: sortedEntries.map((entry) => entry.item).slice(0, 3),
      products: sortedEntries.map((entry) => entry.item),
      availableColors: getAvailableColors(sortedEntries.map((entry) => entry.item))
    };
  }

  return {
    product: sortedEntries[0].item,
    alternatives: [],
    products: sortedEntries.map((entry) => entry.item),
    availableColors: getAvailableColors(sortedEntries.map((entry) => entry.item))
  };
}

function normalizeSearchInput(
  input: InventorySearchInput | null | undefined
): { productName: string; category: string; color: string } {
  const safeInput = input ?? {};

  return {
    productName: normalize(safeInput.productName ?? ""),
    category: normalizeCategory(safeInput.category),
    color: normalizeColor(safeInput.color)
  };
}

function scoreItemByName(item: InventoryItem, normalizedProductName: string): number {
  const normalizedName = normalize(item.name);
  const keywordPhrases = (item.keywords ?? []).map(normalize);
  const tokenPool = new Set([
    ...tokenize(item.name),
    ...tokenize(item.category),
    ...tokenize(item.color),
    ...keywordPhrases.flatMap((keyword) => tokenize(keyword))
  ]);

  let score = 0;

  if (normalizedName === normalizedProductName) {
    score += 100;
  }

  if (normalizedName.includes(normalizedProductName)) {
    score += 60;
  }

  if (keywordPhrases.includes(normalizedProductName)) {
    score += 70;
  }

  for (const token of tokenize(normalizedProductName)) {
    if (tokenPool.has(token)) {
      score += 18;
    } else if ([...tokenPool].some((poolToken) => poolToken.includes(token))) {
      score += 8;
    }
  }

  return score;
}

function getAvailableColors(items: InventoryItem[]): string[] {
  return [...new Set(items.map((item) => item.color))].sort();
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

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .map((token) => singularize(token))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function singularize(token: string): string {
  if (token.endsWith("es")) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s")) {
    return token.slice(0, -1);
  }

  return token;
}

function normalizeCategory(value: string | null | undefined): string {
  const normalized = singularize(normalize(value));
  const aliases: Record<string, string> = {
    hudi: "hoodie",
    sudadera: "hoodie",
    yuger: "jogger",
    camisa: "camiseta",
    playera: "camiseta",
    polo: "polo",
    pantaloneta: "short"
  };

  if (
    normalized === "ropa" ||
    normalized === "clothing" ||
    normalized === "clothe" ||
    normalized === "prenda" ||
    normalized === "articulo"
  ) {
    return "";
  }

  return aliases[normalized] ?? normalized;
}

function normalizeColor(value: string | null | undefined): string {
  const normalized = normalize(value);

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

const STOPWORDS = new Set([
  "de",
  "del",
  "el",
  "la",
  "las",
  "los",
  "ropa",
  "todo",
  "toda"
]);

export const inventoryService = new InventoryService();
