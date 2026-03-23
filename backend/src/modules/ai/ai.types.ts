export const intentOptions = [
  "greeting",
  "faq_location",
  "faq_hours",
  "faq_payment",
  "faq_shipping",
  "price_question",
  "product_search",
  "collection_request",
  "product_availability",
  "buying_intent",
  "human_request",
  "unknown"
] as const;

export const toneOptions = ["casual", "neutral", "formal", "upset"] as const;

export type IntentName = (typeof intentOptions)[number];
export type ToneName = (typeof toneOptions)[number];

export type IntentClassification = {
  intent: IntentName;
  productName: string | null;
  category: string | null;
  color: string | null;
  quantity: number | null;
  isListRequest: boolean;
  refersToPreviousProduct: boolean;
  handoff: boolean;
  tone: ToneName;
};
