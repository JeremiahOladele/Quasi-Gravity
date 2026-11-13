/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { OpenAICompatProvider } from '../core/providers/openaiCompat';
import { redactSecrets } from '../core/redact';
import { ChatChunk, ProviderConfig } from '../core/types';

const KEY = 'sk-very-secret-key-1234567890';
const originalFetch = globalThis.fetch;

function makeConfig(): ProviderConfig {
	return {
		id: 'leak',
		name: 'Leak',
		kind: 'cloud',
		apiType: 'openai-compat',
		baseUrl: 'https://example.com',
		requiresKey: true,
	};
}

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return { ...makeConfig(), ...overrides };
}

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
	const out: ChatChunk[] = [];
	for await (const chunk of iter) {
		out.push(chunk);
	}
	return out;
}

describe('redactSecrets', () => {
	it('replaces every occurrence of a secret', () => {
		assert.strictEqual(redactSecrets(`a ${KEY} b ${KEY} c`, KEY), 'a *** b *** c');
	});
	it('ignores undefined/empty secrets', () => {
		assert.strictEqual(redactSecrets('unchanged', undefined, ''), 'unchanged');
	});
});

describe('no secret leaks in provider errors', () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('chat network error message does not contain the key', async () => {
		globalThis.fetch = (async () => { throw new Error(`request failed with ${KEY}`); }) as typeof fetch;
		const provider = new OpenAICompatProvider(config(), async () => KEY);
		const out = await collect(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
		const message = (out[0] as { type: 'error'; message: string }).message;
		assert.ok(!message.includes(KEY), message);
		assert.ok(message.includes('***'), message);
	});

	it('chat 401 body does not leak the key', async () => {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 401,
			text: async () => `invalid key ${KEY}`,
			json: async () => ({}),
			body: null,
		} as unknown as Response)) as typeof fetch;
		const provider = new OpenAICompatProvider(config(), async () => KEY);
		const out = await collect(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
		const message = (out[0] as { type: 'error'; message: string }).message;
		assert.ok(!message.includes(KEY), message);
	});

	it('chat stream error does not leak the key', async () => {
		globalThis.fetch = (async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error(`stream broke near ${KEY}`));
				}
			});
			return { ok: true, status: 200, body, text: async () => '', json: async () => ({}) } as unknown as Response;
		}) as typeof fetch;
		const provider = new OpenAICompatProvider(config(), async () => KEY);
		const out = await collect(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
		const message = (out[0] as { type: 'error'; message: string }).message;
		assert.ok(!message.includes(KEY), message);
	});

	it('listModels ProviderError does not leak the key', async () => {
		globalThis.fetch = (async () => { throw new Error(`cannot reach host using ${KEY}`); }) as typeof fetch;
		const provider = new OpenAICompatProvider(config(), async () => KEY);
		await assert.rejects(
			() => provider.listModels(),
			(err: Error) => !err.message.includes(KEY) && err.message.includes('***')
		);
	});
});
