/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseOllamaTags, parseOpenAiModels, probeLocalServers } from '../core/discovery';

const originalFetch = globalThis.fetch;

describe('parseOpenAiModels', () => {
	it('reads ids from a well-formed response', () => {
		assert.deepStrictEqual(parseOpenAiModels({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
	});
	it('skips malformed entries and missing data', () => {
		assert.deepStrictEqual(parseOpenAiModels({ data: [{ id: 'a' }, {}, { id: 2 }, null] }), ['a']);
		assert.deepStrictEqual(parseOpenAiModels({}), []);
		assert.deepStrictEqual(parseOpenAiModels(null), []);
		assert.deepStrictEqual(parseOpenAiModels('nope'), []);
	});
});

describe('parseOllamaTags', () => {
	it('reads names from a well-formed response', () => {
		assert.deepStrictEqual(parseOllamaTags({ models: [{ name: 'llama3:latest' }, { model: 'qwen:7b' }] }), ['llama3:latest', 'qwen:7b']);
	});
	it('skips malformed entries and missing models', () => {
		assert.deepStrictEqual(parseOllamaTags({ models: [{ name: 'ok' }, {}, { name: 3 }, null] }), ['ok']);
		assert.deepStrictEqual(parseOllamaTags({}), []);
		assert.deepStrictEqual(parseOllamaTags(undefined), []);
	});
});

describe('probeLocalServers', () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];

	afterEach(() => {
		globalThis.fetch = originalFetch;
		calls.length = 0;
	});

	function stubFetch(handler: (url: string) => { status: number; body: unknown } | undefined): void {
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = String(url);
			calls.push({ url: target, init: init ?? {} });
			const response = handler(target);
			if (!response) {
				throw new Error('not found');
			}
			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				json: async () => response.body,
			} as Response;
		}) as typeof fetch;
	}

	it('probes only loopback hosts with GET and no auth headers', async () => {
		stubFetch(url => url === 'http://localhost:11434/api/tags' ? { status: 200, body: { models: [{ name: 'llama3' }] } } : undefined);
		await probeLocalServers(undefined, 250);

		assert.ok(calls.length > 0);
		for (const call of calls) {
			assert.match(call.url, /^http:\/\/localhost:\d+\//);
			assert.strictEqual(call.init.method, 'GET');
			assert.strictEqual(call.init.headers, undefined);
		}
	});

	it('returns the servers that responded', async () => {
		stubFetch(url => {
			if (url === 'http://localhost:11434/api/tags') {
				return { status: 200, body: { models: [{ name: 'llama3' }] } };
			}
			if (url === 'http://localhost:8000/v1/models') {
				return { status: 200, body: { data: [{ id: 'mistral' }] } };
			}
			return undefined;
		});
		const found = await probeLocalServers(undefined, 250);
		const byId = new Map(found.map(server => [server.id, server]));
		assert.deepStrictEqual(byId.get('ollama')?.models, ['llama3']);
		assert.strictEqual(byId.get('ollama')?.port, 11434);
		assert.deepStrictEqual(byId.get('vllm')?.models, ['mistral']);
		assert.strictEqual(byId.has('lmstudio'), false);
	});

	it('ignores failures and non-2xx responses', async () => {
		stubFetch(() => ({ status: 500, body: {} }));
		assert.deepStrictEqual(await probeLocalServers(undefined, 250), []);
	});
});
