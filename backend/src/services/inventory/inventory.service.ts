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
    const safeInput = input ?? {};
    const scoredItems = this.search(safeInput);

    if (scoredItems.length === 0) {
      return { product: null, alternatives: [], products: [] };
    }

    const topScore = scoredItems[0].score;
    const strongMatches = scoredItems.filter(
      (entry) => topScore - entry.score <= 10 && entry.score >= 35
    );

    if (strongMatches.length > 1) {
      return {
        product: null,
        alternatives: strongMatches.map((entry) => entry.item).slice(0, 3),
        products: strongMatches.map((entry) => entry.item)
      };
    }

    return {
      product: scoredItems[0].item,
      alternatives: [],
      products: scoredItems.map((entry) => entry.item)
    };
  }

  search(
    input: InventorySearchInput | null | undefined
  ): Array<{ item: InventoryItem; score: number }> {
    const safeInput = input ?? {};
    const normalizedProductName = normalize(safeInput.productName ?? "");
    const normalizedCategory = normalizeCategory(safeInput.category);
    const normalizedColor = normalizeColor(safeInput.color);

    return this.getInventory()
      .map((item) => ({
        item,
        score: scoreItem(item, {
          productName: normalizedProductName,
          category: normalizedCategory,
          color: normalizedColor
        })
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
  }
}

function scoreItem(
  item: InventoryItem,
  input: { productName: string; category: string; color: string }
): number {
  let score = 0;
  let matchedStructuredFilter = false;
  const normalizedName = normalize(item.name);
  const normalizedCategory = normalizeCategory(item.category);
  const normalizedColor = normalizeColor(item.color);
  const keywordPhrases = (item.keywords ?? []).map(normalize);
  const tokenPool = new Set([
    ...tokenize(item.name),
    ...tokenize(item.category),
    ...tokenize(item.color),
    ...keywordPhrases.flatMap((keyword) => tokenize(keyword))
  ]);

  if (input.category) {
    if (normalizedCategory === input.category) {
      score += 45;
      matchedStructuredFilter = true;
    } else if (normalizedCategory.includes(input.category)) {
      score += 25;
      matchedStructuredFilter = true;
    }
  }

  if (input.color) {
    if (normalizedColor === input.color) {
      score += 35;
      matchedStructuredFilter = true;
    } else if (normalizedName.includes(input.color)) {
      score += 20;
      matchedStructuredFilter = true;
    }
  }

  if (input.productName) {
    if (normalizedName === input.productName) {
      score += 100;
    }

    if (normalizedName.includes(input.productName)) {
      score += 60;
    }

    if (keywordPhrases.includes(input.productName)) {
      score += 70;
    }

    for (const token of tokenize(input.productName)) {
      if (tokenPool.has(token)) {
        score += 18;
      } else if ([...tokenPool].some((poolToken) => poolToken.includes(token))) {
        score += 8;
      }
    }
  }

  if (!input.productName && matchedStructuredFilter) {
    score += 10;
  }

  return score;
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
  return singularize(normalize(value));
}

function normalizeColor(value: string | null | undefined): string {
  const normalized = normalize(value);

  if (normalized === "negra") {
    return "negro";
  }

  if (normalized === "blanca") {
    return "blanco";
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
