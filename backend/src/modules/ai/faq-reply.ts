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
  const pendingPurchaseSuffix = hasPendingPurchaseContext
    ? " Si queres, despues seguimos con tu pedido 🙌"
    : null;
  const activeBuyingSuffix = isSameTurnBuyingIntent
    ? " El equipo te confirma ese detalle por este medio."
    : null;

  switch (classification.intent) {
    case "faq_location":
      return (
        "Sobre la ubicacion, te la confirma el equipo por este medio." +
        (activeBuyingSuffix ??
          pendingPurchaseSuffix ??
          " Si quieres, te sigo ayudando con productos o compra mientras tanto.")
      );
    case "faq_hours":
      return (
        "Sobre el horario, te lo confirma el equipo por este medio." +
        (activeBuyingSuffix ??
          pendingPurchaseSuffix ??
          " Si quieres, tambien te ayudo con productos o disponibilidad.")
      );
    case "faq_payment":
      return (
        "Sobre metodos de pago, el equipo te confirma las opciones disponibles por este medio." +
        (activeBuyingSuffix ??
          pendingPurchaseSuffix ??
          " Si quieres, mientras tanto te ayudo con productos o precios.")
      );
    case "faq_shipping":
      return (
        "Sobre envios, el equipo te confirma cobertura y condiciones por este medio." +
        (activeBuyingSuffix ??
          pendingPurchaseSuffix ??
          " Si quieres, te ayudo mientras tanto con productos o compra.")
      );
    default:
      return (
        "Te ayudo con eso." +
        (activeBuyingSuffix ??
          pendingPurchaseSuffix ??
          " Si quieres, dime que necesitas y seguimos.")
      );
  }
}
