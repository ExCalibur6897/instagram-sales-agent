import { IntentClassification } from "./ai.types";

export function buildFaqReply(classification: IntentClassification): string {
  switch (classification.intent) {
    case "faq_location":
      return "Sobre la ubicación, te la confirma el equipo por este medio. Si quieres, te sigo ayudando con productos o compra mientras tanto.";
    case "faq_hours":
      return "Sobre el horario, te lo confirma el equipo por este medio. Si quieres, también te ayudo con productos o disponibilidad.";
    case "faq_payment":
      return "Sobre métodos de pago, el equipo te confirma las opciones disponibles por este medio. Si quieres, mientras tanto te ayudo con productos o precios.";
    case "faq_shipping":
      return "Sobre envíos, el equipo te confirma cobertura y condiciones por este medio. Si quieres, te ayudo mientras tanto con productos o compra.";
    default:
      return "Te ayudo con eso. Si quieres, dime qué necesitas y seguimos.";
  }
}
