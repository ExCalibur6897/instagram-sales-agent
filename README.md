# Instagram Sales Agent v0.2

Proyecto de practica para un agente de ventas de Instagram. Esta version integra OpenAI en el backend para clasificar la intencion del mensaje y generar respuestas breves en espanol.

## Stack

- Node.js
- Express
- TypeScript
- OpenAI API
- dotenv

## Estructura

```text
backend/
  src/
    config/
    modules/
      ai/
      messages/
    services/
      inventory/
      openai/
data/
  inventory.json
```

## Requisitos

- Node.js 20 o superior
- npm
- Una API key de OpenAI

## Configuracion local

1. Entra al backend:

```bash
cd backend
```

2. Instala dependencias:

```bash
npm install
```

3. Crea el archivo `.env`:

```bash
copy .env.example .env
```

4. Configura tus variables:

```env
PORT=3000
OPENAI_API_KEY=tu_api_key
OPENAI_MODEL=gpt-4.1-mini
```

5. Inicia el servidor:

```bash
npm run dev
```

El backend corre por defecto en `http://localhost:3000`.

## Scripts

- `npm run dev`: inicia el servidor con recarga automatica
- `npm run build`: compila TypeScript a `dist/`
- `npm run start`: ejecuta la version compilada

## Endpoint

### `POST /message`

Recibe un mensaje, clasifica la intencion, busca producto en `data/inventory.json` si hace falta y genera una respuesta final.

La busqueda de productos tolera referencias parciales o informales usando normalizacion de texto, coincidencias parciales y keywords del inventario. Si hay varias coincidencias razonables, el backend pide aclaracion.

Para pruebas del flujo de compra, puedes enviar tambien `userId` en el body. Ese identificador se usa para mantener en memoria el estado `collect_order_data` entre mensajes del mismo usuario.
El backend tambien guarda memoria corta por `userId` para contexto reciente: ultimo producto, categoria, color e intent.

Ejemplo:

```bash
curl -X POST http://localhost:3000/message ^
  -H "Content-Type: application/json" ^
  -d "{\"userId\":\"wilson\",\"message\":\"Hola, cuanto cuesta la negra?\"}"
```

Respuesta esperada:

```json
{
  "success": true,
  "data": {
    "channel": "instagram",
    "userMessage": "Hola, cuanto cuesta la negra?",
    "intent": "price_question",
    "productFound": true,
    "agentReply": "La Camiseta negra oversize cuesta 420 HNL. Si quieres, te ayudo a seguir con la compra.",
    "usedOpenAI": true,
    "handoff": false
  }
}
```

### `GET /debug/orders`

Devuelve todas las ordenes guardadas en memoria para pruebas locales.

### `GET /debug/state`

Devuelve el estado actual en memoria de usuarios que siguen en flujo de compra y la memoria corta conversacional por usuario.

## Modulos principales

- `src/modules/ai/classify-intent.ts`: clasifica intencion, tono, handoff y producto
- `src/modules/ai/generate-reply.ts`: genera una respuesta corta y natural en espanol
- `src/services/inventory/inventory.service.ts`: carga el inventario y busca productos
- `src/services/openai/openai.client.ts`: usa el SDK oficial y la API `responses`

## Comportamiento esperado

- El sistema usa OpenAI para clasificar y responder.
- Si la consulta es sobre precio o disponibilidad, intenta usar `inventory.json` como contexto.
- La busqueda de productos acepta nombres incompletos como `gorra`, `hoodie gris` o `la negra` cuando hay una mejor coincidencia clara.
- El backend entiende mejor consultas abiertas como categorias, colores, listas y referencias al contexto reciente.
- Si un usuario entra en `nextStep = collect_order_data`, el backend recuerda ese estado en memoria usando `userId`.
- Cuando el usuario envia sus datos, el backend extrae nombre, direccion y metodo de pago, los guarda en memoria y confirma el cierre.
- Puedes revisar lo guardado localmente en `/debug/orders` y `/debug/state`.
- Si no encuentra informacion confiable, evita inventar datos y sugiere pasar con alguien del equipo.
- Si `OPENAI_API_KEY` no esta configurada, usa respuestas de respaldo para seguir funcionando en local.
