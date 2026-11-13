/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { redactSecrets } from '../redact';
import { parseSseEvents } from '../sse';
import { ChatChunk, ChatMessage, ChatRequest, KeyResolver, ModelInfo, Provider, ProviderConfig, ProviderError, normalizeBaseUrl } from '../types';

interface OpenAIModelListResponse {
	data?: Array<{ id?: string; name?: string }>;
}

interface StreamToolCallDelta {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface StreamChunkData {
	choices?: Array<{ delta?: { content?: string | null; tool_calls?: StreamToolCallDelta[] }; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
}

const MAX_ERROR_BODY_LENGTH = 500;

export class OpenAICompatProvider implements Provider {

	constructor(
		readonly config: ProviderConfig,
		private readonly keyResolver: KeyResolver
	) { }

	private endpoint(path: string): string {
		return `${normalizeBaseUrl(this.config.baseUrl)}${path}`;
	}

	private async resolveKey(): Promise<string | undefined> {
		return this.config.requiresKey ? this.keyResolver(this.config.id) : undefined;
	}

	private headers(key: string | undefined): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (key) {
			headers['Authorization'] = `Bearer ${key}`;
		}
		return headers;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const key = await this.resolveKey();
		let res: Response;
		try {
			res = await fetch(this.endpoint('/models'), { method: 'GET', headers: this.headers(key), signal });
		} catch (err) {
			throw new ProviderError(redactSecrets(errorMessage(err), key));
		}
		if (!res.ok) {
			throw new ProviderError(redactSecrets(await responseMessage(res), key), res.status);
		}
		const json = await res.json() as OpenAIModelListResponse;
		const data = json.data ?? [];
		return data
			.filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
			.map(m => ({ id: m.id, name: m.name }));
	}

	async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
		const key = await this.resolveKey();
		const body = {
			model: req.model,
			messages: toWireMessages(req.messages),
			...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
			...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
			...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
			stream: true,
		};

		let res: Response;
		try {
			res = await fetch(this.endpoint('/chat/completions'), {
				method: 'POST',
				headers: this.headers(key),
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			yield { type: 'error', message: redactSecrets(errorMessage(err), key) };
			return;
		}

		if (!res.ok) {
			yield { type: 'error', message: redactSecrets(await responseMessage(res), key), status: res.status };
			return;
		}

		if (!res.body) {
			yield { type: 'error', message: 'Empty response body' };
			return;
		}

		const toolCalls = new Map<number, ToolCallAccumulator>();
		let usage: { inputTokens?: number; outputTokens?: number } | undefined;

		try {
			for await (const data of parseSseEvents(readBodyChunks(res.body))) {
				if (data === '[DONE]') {
					break;
				}
				let parsed: StreamChunkData;
				try {
					parsed = JSON.parse(data) as StreamChunkData;
				} catch {
					continue;
				}
				if (parsed.usage) {
					usage = { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens };
				}
				const delta = parsed.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				if (typeof delta.content === 'string' && delta.content.length > 0) {
					yield { type: 'text', text: delta.content };
				}
				if (delta.tool_calls) {
					for (const call of delta.tool_calls) {
						const index = call.index ?? 0;
						let acc = toolCalls.get(index);
						if (!acc) {
							acc = { id: '', name: '', arguments: '' };
							toolCalls.set(index, acc);
						}
						if (call.id) { acc.id = call.id; }
						if (call.function?.name) { acc.name += call.function.name; }
						if (call.function?.arguments) { acc.arguments += call.function.arguments; }
					}
				}
			}
		} catch (err) {
			yield { type: 'error', message: redactSecrets(errorMessage(err), key) };
			return;
		}

		for (const acc of toolCalls.values()) {
			yield { type: 'toolCall', call: { id: acc.id, type: 'function', function: { name: acc.name, arguments: acc.arguments } } };
		}

		yield { type: 'done', usage };
	}

	async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; models?: ModelInfo[] }> {
		try {
			const models = await this.listModels(signal);
			return { ok: true, message: 'OK', models };
		} catch (err) {
			return { ok: false, message: errorMessage(err) };
		}
	}
}

interface WireMessage {
	readonly role: string;
	readonly content: string;
	readonly tool_calls?: unknown;
	readonly tool_call_id?: string;
}

/** Map internal conversation messages to the OpenAI wire format for tool turns. */
function toWireMessages(messages: ReadonlyArray<ChatMessage>): WireMessage[] {
	return messages.map(message => ({
		role: message.role,
		content: message.content,
		...(message.toolCalls && message.toolCalls.length > 0 ? { tool_calls: message.toolCalls } : {}),
		...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
	}));
}

async function* readBodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

async function responseMessage(res: Response): Promise<string> {
	let body = '';
	try {
		body = (await res.text()).trim();
	} catch {
		// ignore body read failures
	}
	if (body.length > MAX_ERROR_BODY_LENGTH) {
		body = body.slice(0, MAX_ERROR_BODY_LENGTH) + '\u2026';
	}
	return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError') {
			return 'Request aborted';
		}
		return err.message;
	}
	return String(err);
}
