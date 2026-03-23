import { IntentClassification } from "./ai.types";

type FaqReplyOptions = {
  hasPendingPurchaseContext?: boolean;
  isSameTurnBuyingIntent?: boolean;
};

export function buildFaqReply(
  classification: IntentClassification,
  options: FaqReplyOptions = {}
): string {
  const hasPendingPurchaseContext = options.hasPendingPurchaseContext ?? false;
  const isSameTurnBuyingIntent = options.isSameTurnBuyingIntent ?? false;
  const purchaseSuffix = hasPendingPurchaseContext
    ? " Si quer\u00e9s, seguimos con tu pedido \ud83d\ude4c"
    : null;
  const sameTurnBuyingSuffix = isSameTurnBuyingIntent
    ? " El equipo te confirma ese detalle por este medio."
    : null;

  switch (classification.intent) {
    case "faq_location":
      return (
        "Sobre la ubicaci\u00f3n, te la confirma el equipo por este medio." +
        (sameTurnBuyingSuffix ??
          purchaseSuffix ??
          " Si quer\u00e9s, tambi\u00e9n te ayudo con productos o compra.")
      );
    case "faq_hours":
      return (
        "Sobre el horario, te lo confirma el equipo por este medio." +
        (sameTurnBuyingSuffix ??
          purchaseSuffix ??
          " Si quer\u00e9s, tambi\u00e9n te ayudo con productos o disponibilidad.")
      );
    case "faq_payment":
      return (
        "Sobre m\u00e9todos de pago, el equipo te confirma las opciones disponibles por este medio." +
        (sameTurnBuyingSuffix ??
          purchaseSuffix ??
          " Si quer\u00e9s, tambi\u00e9n te ayudo con productos o precios.")
      );
    case "faq_shipping":
      return (
        "Sobre env\u00edos, el equipo te confirma cobertura y condiciones por este medio." +
        (sameTurnBuyingSuffix ??
          purchaseSuffix ??
          " Si quer\u00e9s, tambi\u00e9n te ayudo con productos o compra.")
      );
    default:
      return (
        "Te ayudo con eso." +
        (sameTurnBuyingSuffix ??
          purchaseSuffix ??
          " Si quer\u00e9s, decime qu\u00e9 necesit\u00e1s y seguimos.")
      );
  }
}
