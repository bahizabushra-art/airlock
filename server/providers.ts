import { GoogleGenAI } from '@google/genai';
import type { ProviderId } from './types.ts';

export interface ProviderStatusInfo {
  id: ProviderId;
  name: string;
  configured: boolean;
  envVar: string;
  models: Array<{ id: string; label: string; tier: string }>;
  note: string;
}

export const PROVIDER_CATALOG: Array<Omit<ProviderStatusInfo, 'configured'>> = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (Fast Free Tier)', tier: 'Default' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Balanced)', tier: 'Standard' },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon (Complex Reasoning)', tier: 'Pro' },
      { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon (Deep Security Audit)', tier: 'Advanced' },
    ],
    note: 'Uses server-side @google/genai SDK via GEMINI_API_KEY.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'Flagship' },
      { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'Reasoning' },
      { id: 'o3-mini', label: 'o3-mini', tier: 'Compact' },
    ],
    note: 'Routed server-side via OPENAI_API_KEY environment variable.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    envVar: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'Flagship' },
      { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', tier: 'Balanced' },
    ],
    note: 'Routed server-side via ANTHROPIC_API_KEY environment variable.',
  },
  {
    id: 'custom',
    name: 'Self-Hosted / OpenAI-Compatible',
    envVar: 'Custom Base URL',
    models: [
      { id: 'llama-3.3-70b-instruct', label: 'Llama 3.3 70B (Local vLLM/Ollama)', tier: 'On-Prem' },
      { id: 'qwen-2.5-32b-instruct', label: 'Qwen 2.5 32B (Local)', tier: 'On-Prem' },
    ],
    note: 'Connects to a local OpenAI-compatible inference endpoint (e.g. http://127.0.0.1:11434/v1).',
  },
];

export function getProviderStatuses(customEndpointUrl = ''): ProviderStatusInfo[] {
  return PROVIDER_CATALOG.map((p) => {
    let configured = false;
    if (p.id === 'gemini') configured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
    if (p.id === 'openai') configured = Boolean(process.env.OPENAI_API_KEY);
    if (p.id === 'anthropic') configured = Boolean(process.env.ANTHROPIC_API_KEY);
    if (p.id === 'custom') configured = Boolean(customEndpointUrl.trim());
    return { ...p, configured };
  });
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('PROVIDER_NOT_CONFIGURED: GEMINI_API_KEY is missing in server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface StreamProviderParams {
  provider: ProviderId;
  model: string;
  sanitizedPrompt: string;
  systemInstruction: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  customEndpointUrl?: string;
  onChunk: (textChunk: string) => void;
}

function formatProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const outer = JSON.parse(raw) as { error?: { message?: string; code?: number; status?: string } };
    if (outer?.error?.message) {
      try {
        const inner = JSON.parse(outer.error.message) as { error?: { message?: string; code?: number } };
        if (inner?.error?.message) return inner.error.message;
      } catch {
        return outer.error.message;
      }
    }
  } catch {
    // Not raw JSON
  }
  return raw;
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('ECONNRESET');
}

/**
 * Calls the configured external LLM strictly with the SANITIZED prompt (only placeholders).
 */
export async function streamSanitizedToProvider(params: StreamProviderParams): Promise<string> {
  const { provider, model, sanitizedPrompt, systemInstruction, history, customEndpointUrl, onChunk } = params;

  if (provider === 'gemini') {
    const ai = getGeminiClient();
    const contents = [
      ...history.slice(-8).map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      })),
      { role: 'user', parts: [{ text: sanitizedPrompt }] },
    ];

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stream = await ai.models.generateContentStream({
          model: model || 'gemini-3.1-flash-lite',
          contents,
          config: {
            systemInstruction,
          },
        });

        let full = '';
        for await (const chunk of stream) {
          const piece = chunk.text || '';
          if (piece) {
            full += piece;
            onChunk(piece);
          }
        }
        return full;
      } catch (err) {
        lastErr = err;
        if (attempt < 2 && isTransientError(err)) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        throw new Error(formatProviderError(err));
      }
    }
    throw new Error(formatProviderError(lastErr));
  }

  if (provider === 'openai' || provider === 'custom') {
    const isCustom = provider === 'custom';
    const apiKey = isCustom ? process.env.OPENAI_API_KEY || 'local-gateway' : process.env.OPENAI_API_KEY;
    if (!isCustom && !apiKey) {
      throw new Error('PROVIDER_NOT_CONFIGURED: OPENAI_API_KEY is not configured in server environment variables. Select Google Gemini or configure OPENAI_API_KEY.');
    }
    if (isCustom && !customEndpointUrl?.trim()) {
      throw new Error('PROVIDER_NOT_CONFIGURED: Custom OpenAI-compatible endpoint URL is empty.');
    }

    const baseUrl = isCustom ? customEndpointUrl!.replace(/\/$/, '') : 'https://api.openai.com/v1';
    const messages = [
      { role: 'system', content: systemInstruction },
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: sanitizedPrompt },
    ];

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const errBody = await response.text();
      throw new Error(`Upstream ${provider} error (${response.status}): ${errBody.slice(0, 240)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = parsed.choices?.[0]?.delta?.content ?? '';
          if (piece) {
            full += piece;
            onChunk(piece);
          }
        } catch {
          // Ignore incomplete JSON line
        }
      }
    }
    return full;
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('PROVIDER_NOT_CONFIGURED: ANTHROPIC_API_KEY is not configured in server environment variables. Select Google Gemini or configure ANTHROPIC_API_KEY.');
    }

    const messages = [
      ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: sanitizedPrompt },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemInstruction,
        messages,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Upstream Anthropic error (${response.status}): ${errBody.slice(0, 240)}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const full = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('');
    if (full) onChunk(full);
    return full;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Verifies real server-side connectivity to the selected provider using a benign ping.
 */
export async function testProviderConnectivity(
  provider: ProviderId,
  model: string,
  customEndpointUrl?: string
): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
  const start = Date.now();
  try {
    let reply = '';
    await streamSanitizedToProvider({
      provider,
      model,
      sanitizedPrompt: 'Reply with exactly: AIRLOCK_OK',
      systemInstruction: 'Respond concisely with AIRLOCK_OK.',
      history: [],
      customEndpointUrl,
      onChunk: (c) => {
        reply += c;
      },
    });
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: `Connected to ${provider} (${model}). Response: ${reply.trim().slice(0, 60)}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}
