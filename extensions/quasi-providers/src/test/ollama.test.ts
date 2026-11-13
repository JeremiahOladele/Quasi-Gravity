/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { OllamaProvider, parseOllamaCapabilities } from '../core/providers/ollama';
import { ChatChunk, ProviderConfig } from '../core/types';

const config: ProviderConfig = {
	id: 'ollama',
	name: 'Ollama',
	kind: 'local',
	apiType: 'ollama',
	baseUrl: 'http://localhost:11434/v1',
	requiresKey: false,
};

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		body: null,
	} as unknown as Response;
}

function sseResponse(data: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(data));
			controller.close();
		}
	});
	return { ok: true, status: 200, json: async () => ({}), text: async () => '', body } as unknown as Response;
}

function stubFetch(handler: (url: string) => Response | undefined): void {
	globalThis.fetch = (async (url: string | URL | Request) => {
		const response = handler(String(url));
		if (!response) {
			throw new Error(`unexpected request ${url}`);
		}
		return response;
	}) as typeof fetch;
}

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
	const out: ChatChunk[] = [];
	for await (const chunk of iter) {
		out.push(chunk);
	}
	return out;
}

describe('parseOllamaCapabilities', () => {
	it('reads tools/vision from the capabilities array', () => {
		assert.deepStrictEqual(parseOllamaCapabilities({ capabilities: ['completion', 'tools', 'vision'] }), { tools: true, vision: true });
		assert.deepStrictEqual(parseOllamaCapabilities({ capabilities: ['completion'] }), { tools: false, vision: false });
	});
	it('is undefined when the field is missing or malformed', () => {
		assert.strictEqual(parseOllamaCapabilities({}), undefined);
		assert.strictEqual(parseOllamaCapabilities({ capabilities: 'tools' }), undefined);
		assert.strictEqual(parseOllamaCapabilities(null), undefined);
	});
});

describe('OllamaProvider', () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('lists models via the native /api/tags endpoint', async () => {
		stubFetch(url => url === 'http://localhost:11434/api/tags' ? jsonResponse({ models: [{ name: 'llama3:latest' }, { model: 'qwen:7b' }] }) : undefined);
		const provider = new OllamaProvider(config, async () => undefined);
		assert.deepStrictEqual(await provider.listModels(), [{ id: 'llama3:latest' }, { id: 'qwen:7b' }]);
	});

	it('falls back to the OpenAI-compatible model list when native metadata fails', async () => {
		stubFetch(url => {
			if (url === 'http://localhost:11434/api/tags') {
				throw new Error('native unavailable');
			}
			if (url === 'http://localhost:11434/v1/models') {
				return jsonResponse({ data: [{ id: 'fallback-model' }] });
			}
			return undefined;
		});
		const provider = new OllamaProvider(config, async () => undefined);
		assert.deepStrictEqual(await provider.listModels(), [{ id: 'fallback-model', name: undefined }]);
	});

	it('reads capabilities via /api/show', async () => {
		let postBody = '';
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) === 'http://localhost:11434/api/show') {
				postBody = String(init?.body ?? '');
				return jsonResponse({ capabilities: ['completion', 'tools'] });
			}
			throw new Error('unexpected');
		}) as typeof fetch;

		const provider = new OllamaProvider(config, async () => undefined);
		assert.deepStrictEqual(await provider.getModelCapabilities('llama3'), { tools: true, vision: false });
		assert.match(postBody, /"model":"llama3"/);
	});

	it('delegates chat to the OpenAI-compatible adapter', async () => {
		stubFetch(url => {
			if (url === 'http://localhost:11434/v1/chat/completions') {
				return sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
			}
			return undefined;
		});
		const provider = new OllamaProvider(config, async () => undefined);
		const out = await collect(provider.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hello' }] }));
		assert.deepStrictEqual(out, [{ type: 'text', text: 'hi' }, { type: 'done', usage: undefined }]);
	});
});
