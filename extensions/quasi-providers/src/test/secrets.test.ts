/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { KeyStore, SecretBackend } from '../host/secrets';

const KEY = 'sk-test-secret-abcdef';

class FakeBackend implements SecretBackend {
	readonly values = new Map<string, string>();
	failReads = false;
	failWrites = false;
	failDeletes = false;

	async get(key: string): Promise<string | undefined> {
		if (this.failReads) {
			throw new Error('No system keyring available');
		}
		return this.values.get(key);
	}

	async store(key: string, value: string): Promise<void> {
		if (this.failWrites) {
			throw new Error(`No system keyring available (${value})`);
		}
		this.values.set(key, value);
	}

	async delete(key: string): Promise<void> {
		if (this.failDeletes) {
			throw new Error('No system keyring available');
		}
		this.values.delete(key);
	}
}

describe('KeyStore', () => {
	it('persists through the backend when the keyring works', async () => {
		const backend = new FakeBackend();
		const store = new KeyStore(backend);
		const result = await store.setKey('p1', KEY);
		assert.deepStrictEqual(result, { persisted: true });
		assert.strictEqual(backend.values.get('p1'), KEY);
		assert.strictEqual((await store.getKey('p1')).key, KEY);
	});

	it('falls back to a session-only key when storing fails', async () => {
		const backend = new FakeBackend();
		backend.failWrites = true;
		const store = new KeyStore(backend);

		const result = await store.setKey('p1', KEY);
		assert.strictEqual(result.persisted, false);
		assert.ok(result.keyringError);

		const read = await store.getKey('p1');
		assert.strictEqual(read.key, KEY);
		assert.ok(read.keyringError);
	});

	it('never puts the key into a keyring error message', async () => {
		const backend = new FakeBackend();
		backend.failWrites = true;
		const store = new KeyStore(backend);
		const result = await store.setKey('p1', KEY);
		assert.ok(result.keyringError);
		assert.ok(!result.keyringError!.includes(KEY), result.keyringError);
	});

	it('returns a keyring error (not a throw) when reading fails with no session key', async () => {
		const backend = new FakeBackend();
		backend.failReads = true;
		const store = new KeyStore(backend);
		const result = await store.getKey('missing');
		assert.strictEqual(result.key, undefined);
		assert.ok(result.keyringError);
	});

	it('hasKey reflects persisted and session keys', async () => {
		const backend = new FakeBackend();
		const store = new KeyStore(backend);
		assert.strictEqual(await store.hasKey('p1'), false);
		await store.setKey('p1', KEY);
		assert.strictEqual(await store.hasKey('p1'), true);

		const failing = new FakeBackend();
		failing.failWrites = true;
		const sessionStore = new KeyStore(failing);
		await sessionStore.setKey('p2', KEY);
		assert.strictEqual(await sessionStore.hasKey('p2'), true);
	});

	it('deleteKey clears both persisted and session keys without throwing', async () => {
		const backend = new FakeBackend();
		const store = new KeyStore(backend);
		await store.setKey('p1', KEY);
		await store.deleteKey('p1');
		assert.strictEqual(backend.values.has('p1'), false);
		assert.strictEqual((await store.getKey('p1')).key, undefined);

		const failing = new FakeBackend();
		failing.failWrites = true;
		const sessionStore = new KeyStore(failing);
		await sessionStore.setKey('p2', KEY);
		failing.failDeletes = true;
		await assert.doesNotReject(() => sessionStore.deleteKey('p2'));
		assert.strictEqual((await sessionStore.getKey('p2')).key, undefined);
	});
});
