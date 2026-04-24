import type { MemoryProvider } from "../types.js";

export class OllamaProvider implements MemoryProvider {
  name: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;

  constructor(
    baseUrl: string,
    model: string,
    maxTokens: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, ""); // Remove trailing slashes
    this.model = model;
    this.maxTokens = maxTokens;
    this.name = `ollama-${model}`;
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: {
          num_ctx: this.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const message = data.message as { content: string } | undefined;
    const content = message?.content;

    if (!content) {
      throw new Error(
        `Ollama returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    return content;
  }
}