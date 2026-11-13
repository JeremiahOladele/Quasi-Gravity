/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseOllamaTags } from '../discovery';
import { Capabilities, ChatChunk, ChatRequest, KeyResolver, ModelInfo, Provider, ProviderConfig } from '../types';
import { OpenAICompatProvider } from './openaiCompat';

/** Parse an Ollama `/api/show` response into capabilities. Missing data → undefined. */
export function parseOllamaCapabilities(json: unknown): Partial<Capabilities> | undefined {
	if (typeof json !== 'object' || json === null) {
		return undefined;
	}
	const capabilities = (json as Record<string, unknown>).capabilities;
	if (!Array.isArray(capabilities)) {
		return undefined;
	}
	const set = new Set(capabilities.filter((value): value is string => typeof value === 'string'));
	return { tools: set.has('tools'), vision: set.has('vision') };
}

function originOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}

/**
 * Ollama provider: chat stays on the OpenAI-compatible adapter (`{base}/chat/completions`),
 * while model listing and capability metadata use the native API (`/api/tags`,
 * `/api/show`). All native calls are best-effort and fall back to the
 * OpenAI-compatible model list.
 */
export class OllamaProvider implements Provider {

	private readonly openai: OpenAICompatProvider;

	constructor(
		readonly config: ProviderConfig,
		keyResolver: KeyResolver
	) {
		this.openai = new OpenAICompatProvider(config, keyResolver);
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const origin = originOf(this.config.baseUrl);
		if (origin) {
			try {
				const res = await fetch(`${origin}/api/tags`, { method: 'GET', signal });
				if (res.ok) {
					const names = parseOllamaTags(await res.json());
					if (names.length > 0) {
						return names.map(id => ({ id }));
					}
				}
			} catch {
				// Fall back to the OpenAI-compatible model list below.
			}
		}
		return this.openai.listModels(signal);
	}

	chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
		return this.openai.chat(req, signal);
	}

	async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; models?: ModelInfo[] }> {
		try {
			const models = await this.listModels(signal);
			return { ok: true, message: 'OK', models };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	async getModelCapabilities(modelId: string, signal?: AbortSignal): Promise<Partial<Capabilities> | undefined> {
		const origin = originOf(this.config.baseUrl);
		if (!origin) {
			return undefined;
		}
		try {
			const res = await fetch(`${origin}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: modelId }),
				signal,
			});
			if (!res.ok) {
				return undefined;
			}
			return parseOllamaCapabilities(await res.json());
		} catch {
			return undefined;
		}
	}
}
