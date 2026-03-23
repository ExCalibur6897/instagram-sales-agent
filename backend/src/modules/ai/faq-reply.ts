import { IntentClassification } from "./ai.types";

export function buildFaqReply(
  classification: IntentClassification,
  hasPendingPurchaseContext = false
): string {
  const purchaseContextSuffix = hasPendingPurchaseContext
    ? " Si queres, despues seguimos con tu pedido 🙌"
    : null;

  switch (classification.intent) {
    case "faq_location":
      return (
        "Sobre la ubicacion, te la confirma el equipo por este medio." +
        (purchaseContextSuffix ??
          " Si quieres, te sigo ayudando con productos o compra mientras tanto.")
      );
    case "faq_hours":
      return (
        "Sobre el horario, te lo confirma el equipo por este medio." +
        (purchaseContextSuffix ??
          " Si quieres, tambien te ayudo con productos o disponibilidad.")
      );
    case "faq_payment":
      return (
        "Sobre metodos de pago, el equipo te confirma las opciones disponibles por este medio." +
        (purchaseContextSuffix ??
          " Si quieres, mientras tanto te ayudo con productos o precios.")
      );
    case "faq_shipping":
      return (
        "Sobre envios, el equipo te confirma cobertura y condiciones por este medio." +
        (purchaseContextSuffix ??
          " Si quieres, te ayudo mientras tanto con productos o compra.")
      );
    default:
      return (
        "Te ayudo con eso." +
        (purchaseContextSuffix ?? " Si quieres, dime que necesitas y seguimos.")
      );
  }
}
