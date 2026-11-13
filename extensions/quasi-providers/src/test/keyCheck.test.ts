/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { checkApiKey } from '../core/keyCheck';

const KEY = 'sk-test-secret-abcdef';
const originalFetch = globalThis.fetch;

describe('checkApiKey', () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];

	afterEach(() => {
		globalThis.fetch = originalFetch;
		calls.length = 0;
	});

	function stubStatus(status: number): void {
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return { status, ok: status >= 200 && status < 300 } as Response;
		}) as typeof fetch;
	}

	it('verifies on 2xx and sends the bearer token', async () => {
		stubStatus(200);
		const result = await checkApiKey({ url: 'https://example.com/key' }, KEY);
		assert.strictEqual(result.status, 'verified');
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://example.com/key');
		assert.deepStrictEqual(calls[0].init.headers, { Authorization: `Bearer ${KEY}` });
	});

	it('rejects on 401', async () => {
		stubStatus(401);
		assert.strictEqual((await checkApiKey({ url: 'https://example.com/key' }, KEY)).status, 'rejected');
	});

	it('rejects on 403', async () => {
		stubStatus(403);
		assert.strictEqual((await checkApiKey({ url: 'https://example.com/key' }, KEY)).status, 'rejected');
	});

	it('is unknown when no key-check descriptor exists (public model list)', async () => {
		const result = await checkApiKey(undefined, KEY);
		assert.strictEqual(result.status, 'unknown');
		assert.strictEqual(calls.length, 0);
	});

	it('is unknown on an unexpected status', async () => {
		stubStatus(500);
		assert.strictEqual((await checkApiKey({ url: 'https://example.com/key' }, KEY)).status, 'unknown');
	});

	it('is unknown on a network failure and never leaks the key', async () => {
		globalThis.fetch = (async () => { throw new Error(`network failed near ${KEY}`); }) as typeof fetch;
		const result = await checkApiKey({ url: 'https://example.com/key' }, KEY);
		assert.strictEqual(result.status, 'unknown');
		assert.ok(!JSON.stringify(result).includes(KEY), JSON.stringify(result));
	});
});
