/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ProviderKind = 'cloud' | 'local' | 'remote';

export type ApiType = 'openai-compat' | 'ollama' | 'anthropic' | 'gemini';

export interface ProviderConfig {
	id: string;
	name: string;
	kind: ProviderKind;
	apiType: ApiType;
	baseUrl: string;
	defaultModel?: string;
	requiresKey: boolean;
	capabilities?: Partial<Capabilities>;
}

export interface Capabilities {
	tools: boolean;
	vision: boolean;
	streaming: boolean;
	contextLength?: number;
}

export interface ModelInfo {
	id: string;
	name?: string;
	capabilities?: Partial<Capabilities>;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
}

export interface ToolSpec {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSpec[];
	temperature?: number;
	maxTokens?: number;
}

export type ChatChunk =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; call: ToolCall }
	| { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
	| { type: 'error'; message: string };

export interface Provider {
	readonly config: ProviderConfig;
	listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
	chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
	testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; models?: ModelInfo[] }>;
}

export type KeyResolver = (providerId: string) => Promise<string | undefined>;

export class ProviderError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'ProviderError';
	}
}

/**
 * Normalize an OpenAI-compatible base URL so endpoints can be appended directly
 * (e.g. `{base}/models`, `{base}/chat/completions`).
 *
 * Trims whitespace and trailing slashes, and appends `/v1` only when the URL has
 * no path. URLs that already carry a path (e.g. `/v1`, `/v1beta/openai`,
 * `/inference/v1`) are left as-is so non-`/v1` providers work too.
 */
export function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	try {
		const url = new URL(trimmed);
		if (url.pathname === '' || url.pathname === '/') {
			return `${trimmed}/v1`;
		}
		return trimmed;
	} catch {
		return trimmed;
	}
}
