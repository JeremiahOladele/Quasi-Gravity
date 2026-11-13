/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseHostToWebview, parseWebviewToHost } from '../core/protocol';

describe('parseWebviewToHost', () => {
	it('accepts bare request frames', () => {
		for (const type of ['ready', 'stop', 'newChat', 'addProvider', 'setApiKey']) {
			assert.deepStrictEqual(parseWebviewToHost({ type }), { type });
		}
	});

	it('accepts send with bounded text', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'send', text: 'hello' }), { type: 'send', text: 'hello' });
	});

	it('rejects invalid frames', () => {
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: '' }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: 'x'.repeat(100_001) }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: 42 }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'unknown' }), undefined);
		assert.deepStrictEqual(parseWebviewToHost({ type: 'send', text: 'hi', providerId: 'x' }), { type: 'send', text: 'hi' });
		assert.strictEqual(parseWebviewToHost('nope'), undefined);
		assert.strictEqual(parseWebviewToHost(null), undefined);
	});
});

describe('parseHostToWebview', () => {
	it('accepts history and state frames', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'history', entries: [{ kind: 'user', text: 'hi' }, { kind: 'notice', text: 'note' }] }),
			{ type: 'history', entries: [{ kind: 'user', text: 'hi' }, { kind: 'notice', text: 'note' }] }
		);
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'state', active: { providerName: 'P', model: 'm' }, streaming: false }),
			{ type: 'state', active: { providerName: 'P', model: 'm' }, streaming: false }
		);
		assert.deepStrictEqual(parseHostToWebview({ type: 'state', streaming: true }), { type: 'state', streaming: true });
	});

	it('accepts stream and status frames', () => {
		assert.deepStrictEqual(parseHostToWebview({ type: 'assistantDelta', text: 'a' }), { type: 'assistantDelta', text: 'a' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'assistantDone' }), { type: 'assistantDone' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'busy', value: true }), { type: 'busy', value: true });
		assert.deepStrictEqual(parseHostToWebview({ type: 'cleared' }), { type: 'cleared' });
	});

	it('accepts only whitelisted error kinds with redacted text', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'assistantError', kind: 'rate-limited', message: 'slow down' }),
			{ type: 'assistantError', kind: 'rate-limited', message: 'slow down' }
		);
		assert.strictEqual(parseHostToWebview({ type: 'assistantError', kind: 'weird', message: 'x' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'assistantError', kind: 'offline', message: 5 }), undefined);
	});

	it('rejects malformed frames', () => {
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: [{ kind: 'user' }] }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: 'nope' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'state', active: { providerName: 'P' }, streaming: false }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'state' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'unknown' }), undefined);
	});
});
