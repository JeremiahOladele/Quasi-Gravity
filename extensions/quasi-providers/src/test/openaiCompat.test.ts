/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { OpenAICompatProvider } from '../core/providers/openaiCompat';
import { ChatChunk, ChatRequest, ProviderConfig, normalizeBaseUrl } from '../core/types';

const originalFetch = globalThis.fetch;

function sseData(obj: unknown): string {
	return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function sseResponse(data: string, status = 200): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(data));
			controller.close();
		}
	});
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(data),
		text: async () => data,
		body,
	} as unknown as Response;
}

function jsonResponse(data: string, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(data),
		text: async () => data,
		body: null,
	} as unknown as Response;
}

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: 'test',
		name: 'Test',
		kind: 'cloud',
		apiType: 'openai-compat',
		baseUrl: 'https://example.com',
		requiresKey: false,
		...overrides,
	};
}

async function collectChat(provider: OpenAICompatProvider, req: ChatRequest): Promise<ChatChunk[]> {
	const out: ChatChunk[] = [];
	for await (const chunk of provider.chat(req)) {
		out.push(chunk);
	}
	return out;
}

describe('OpenAICompatProvider', () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];

	afterEach(() => {
		globalThis.fetch = originalFetch;
		calls.length = 0;
	});

	function stubFetch(response: Response): void {
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return response;
		}) as typeof fetch;
	}

	function stubFailingFetch(error: Error): void {
		globalThis.fetch = (async () => { throw error; }) as typeof fetch;
	}

	it('listModels GETs /models with the normalized base URL', async () => {
		stubFetch(jsonResponse('{"data":[{"id":"m1","name":"M1"},{"id":"m2"}]}'));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const models = await provider.listModels();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://example.com/v1/models');
		assert.strictEqual(calls[0].init.method, 'GET');
		assert.deepStrictEqual(models, [{ id: 'm1', name: 'M1' }, { id: 'm2', name: undefined }]);
	});

	it('adds Authorization when requiresKey', async () => {
		stubFetch(jsonResponse('{"data":[]}'));
		const provider = new OpenAICompatProvider(makeConfig({ requiresKey: true }), async () => 'secret');
		await provider.listModels();
		assert.deepStrictEqual(calls[0].init.headers, { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret' });
	});

	it('streams text chunks', async () => {
		const sse = sseData({ choices: [{ delta: { content: 'Hello' } }] }) +
			sseData({ choices: [{ delta: { content: ' world' } }] }) +
			'data: [DONE]\n\n';
		stubFetch(sseResponse(sse));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [
			{ type: 'text', text: 'Hello' },
			{ type: 'text', text: ' world' },
			{ type: 'done', usage: undefined },
		]);
	});

	it('assembles tool calls split across chunks', async () => {
		const sse =
			sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'do', arguments: '' } }] } }] }) +
			sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }) +
			sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }) +
			'data: [DONE]\n\n';
		stubFetch(sseResponse(sse));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [
			{ type: 'toolCall', call: { id: 'call_1', type: 'function', function: { name: 'do', arguments: '{"a":1}' } } },
			{ type: 'done', usage: undefined },
		]);
	});

	it('yields an error chunk on 401', async () => {
		stubFetch(sseResponse('{"error":{"message":"bad key"}}', 401));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [{ type: 'error', message: 'HTTP 401: {"error":{"message":"bad key"}}', status: 401 }]);
	});

	it('yields an error chunk on 403', async () => {
		stubFetch(sseResponse('forbidden', 403));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [{ type: 'error', message: 'HTTP 403: forbidden', status: 403 }]);
	});

	it('yields an error chunk on 429', async () => {
		stubFetch(sseResponse('rate limited', 429));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.strictEqual(out.length, 1);
		assert.deepStrictEqual(out[0], { type: 'error', message: 'HTTP 429: rate limited', status: 429 });
	});

	it('yields an error chunk on network failure', async () => {
		stubFailingFetch(new Error('ECONNREFUSED'));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [{ type: 'error', message: 'ECONNREFUSED' }]);
	});

	it('yields an error chunk on abort', async () => {
		const err = new Error('The operation was aborted');
		err.name = 'AbortError';
		stubFailingFetch(err);
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const out = await collectChat(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(out, [{ type: 'error', message: 'Request aborted' }]);
	});

	it('testConnection reports ok and models', async () => {
		stubFetch(jsonResponse('{"data":[{"id":"m1"}]}'));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const result = await provider.testConnection();
		assert.deepStrictEqual(result, { ok: true, message: 'OK', models: [{ id: 'm1', name: undefined }] });
	});

	it('testConnection reports failure', async () => {
		stubFailingFetch(new Error('down'));
		const provider = new OpenAICompatProvider(makeConfig(), async () => undefined);
		const result = await provider.testConnection();
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.message, 'down');
	});
});

describe('normalizeBaseUrl', () => {
	it('appends /v1 when the URL has no path', () => {
		assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
		assert.strictEqual(normalizeBaseUrl('https://example.com'), 'https://example.com/v1');
	});

	it('keeps an existing path', () => {
		assert.strictEqual(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
		assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
		assert.strictEqual(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai');
		assert.strictEqual(normalizeBaseUrl('https://api.fireworks.ai/inference/v1'), 'https://api.fireworks.ai/inference/v1');
	});

	it('strips trailing slashes', () => {
		assert.strictEqual(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
		assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
	});

	it('keeps saved preset URLs behaving identically (regression)', () => {
		// These are the base URLs the existing M1/M2 presets stored. The old
		// implementation appended /v1 unless the path already ended in /v1.
		assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
		assert.strictEqual(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
		assert.strictEqual(normalizeBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
		assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
	});
});
