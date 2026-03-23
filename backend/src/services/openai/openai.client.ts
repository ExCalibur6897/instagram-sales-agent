import OpenAI from "openai";
import { env } from "../../config/env";

type StructuredOutputInput = {
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
};

type TextInput = {
  instructions: string;
  input: string;
};

class OpenAiClient {
  private client: OpenAI | null = env.openAiApiKey
    ? new OpenAI({ apiKey: env.openAiApiKey })
    : null;

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async generateStructuredOutput<T>(
    params: StructuredOutputInput
  ): Promise<T> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured.");
    }

    const response = await this.client.responses.create({
      model: env.openAiModel,
      instructions: params.instructions,
      input: params.input,
      text: {
        format: {
          type: "json_schema",
          name: params.schemaName,
          schema: params.schema,
          strict: true
        }
      }
    });

    if (!response.output_text) {
      throw new Error("Structured output was empty.");
    }

    return JSON.parse(response.output_text) as T;
  }

  async generateText(params: TextInput): Promise<string> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured.");
    }

    const response = await this.client.responses.create({
      model: env.openAiModel,
      instructions: params.instructions,
      input: params.input
    });

    return response.output_text.trim();
  }
}

export const openAiClient = new OpenAiClient();
