# Instagram Sales Agent

Context-aware AI sales agent built with TypeScript, Express, and the OpenAI API.

The project explores how a conversational sales assistant can understand informal customer messages, maintain short-term context, search a product inventory, manage a shopping cart, and guide users through a checkout flow.

## Overview

Instagram Sales Agent is a backend prototype designed to simulate automated sales conversations through a social-media messaging channel.

Instead of treating every message independently, the system maintains conversational state per user and uses that context to resolve references, products, purchase intentions, and ongoing checkout operations.

## Features

- AI-powered intent classification and natural-language responses
- Context-aware product matching
- Short-term conversational memory per user
- Multi-intent message handling
- Product, category and color recognition
- Shopping cart management
- Multi-item purchase flows
- Add, remove and reduce cart items during checkout
- Resume or cancel an existing purchase flow
- Order-data extraction
- Inventory-backed price and availability responses
- Human handoff signals when appropriate
- Fallback behavior when the OpenAI API is unavailable
- Debug endpoints for inspecting orders and conversational state

## Tech Stack

- TypeScript
- Node.js
- Express
- OpenAI API
- dotenv
- JSON-based product inventory

## Architecture

~~~text
backend/
├── src/
│   ├── config/
│   ├── modules/
│   │   ├── ai/
│   │   └── messages/
│   └── services/
│       ├── checkout/
│       ├── conversation/
│       ├── inventory/
│       └── openai/
└── package.json

data/
└── inventory.json
~~~

The message-processing layer coordinates AI classification, contextual memory, inventory matching and checkout state.

## Conversation Flow

~~~text
Customer Message
       |
       v
Intent & Entity Extraction
       |
       v
Conversation Context
       |
       +----> Inventory Matching
       |
       +----> Cart / Checkout State
       |
       v
Business Logic
       |
       v
AI-Assisted Response
       |
       v
Customer Reply / Handoff
~~~

## Example

A customer can send an informal message such as:

~~~text
Hola, cuánto cuesta la negra?
~~~

The system can use recent conversation context and inventory information to determine which product the customer is referring to and generate an appropriate response.

During a purchase flow, users can also modify their cart naturally:

~~~text
Quitame una de esas y agregame otra gris.
~~~

The backend processes the requested operations while preserving the active checkout state.

## Local Setup

Requirements:

- Node.js 20+
- npm
- OpenAI API key

Clone the repository and enter the backend directory:

~~~bash
git clone git@github.com:ExCalibur6897/instagram-sales-agent.git
cd instagram-sales-agent/backend
~~~

Install dependencies:

~~~bash
npm install
~~~

Create your environment file:

~~~bash
copy .env.example .env
~~~

Configure:

~~~env
PORT=3000
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
~~~

Start development mode:

~~~bash
npm run dev
~~~

The backend runs by default at:

~~~text
http://localhost:3000
~~~

## API

### POST `/message`

Processes an incoming customer message.

Example:

~~~json
{
  "userId": "demo-user",
  "message": "Quiero comprar una camiseta negra"
}
~~~

The service evaluates the user's intent, conversational context, inventory and active purchase state before generating the response.

### GET `/debug/orders`

Returns orders currently stored by the prototype.

### GET `/debug/state`

Returns active checkout and short-term conversational state for debugging.

## OpenAI Integration

The project uses the OpenAI API for language-understanding tasks such as intent recognition, structured data extraction and response generation.

Business-critical product information is resolved against the local inventory rather than invented by the model.

If the API is not configured, fallback behavior allows parts of the backend to continue operating locally.

## Project Purpose

This project was created to explore the design of practical AI agents that combine large language models with deterministic application logic.

The main focus was not simply generating chatbot responses, but coordinating:

- natural-language understanding
- application state
- product inventory
- cart operations
- checkout logic
- conversational context

This separation keeps business rules under application control while using AI where flexible language understanding is useful.

## Current Scope

This is a prototype backend rather than a production Instagram integration.

Messages are submitted through the API, inventory is stored locally, and conversational / checkout state is currently maintained for development and demonstration purposes.

## Author

**Wilson Guerra**  
Computer Systems Engineering student  
GitHub: [@ExCalibur6897](https://github.com/ExCalibur6897)
