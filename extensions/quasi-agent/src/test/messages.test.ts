/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ConversationEntry, dropEmptyAssistant, toProviderMessages } from '../core/messages';

describe('toProviderMessages', () => {
	it('maps user and assistant entries and skips notices', () => {
		const entries: ConversationEntry[] = [
			{ kind: 'user', text: 'hello' },
			{ kind: 'notice', text: 'Switched to X' },
			{ kind: 'assistant', text: 'hi there' },
			{ kind: 'assistant', text: '' }
		];
		assert.deepStrictEqual(toProviderMessages(entries), [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi there' }
		]);
	});

	it('prepends a system message when given', () => {
		assert.deepStrictEqual(toProviderMessages([{ kind: 'user', text: 'q' }], 'sys'), [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'q' }
		]);
	});
});

describe('dropEmptyAssistant', () => {
	it('removes an empty assistant entry', () => {
		const empty = { kind: 'assistant' as const, text: '' };
		const entries: Array<{ kind: 'user' | 'assistant' | 'notice'; text: string }> = [{ kind: 'user', text: 'hi' }, empty];
		assert.strictEqual(dropEmptyAssistant(entries, empty), true);
		assert.deepStrictEqual(entries, [{ kind: 'user', text: 'hi' }]);
	});

	it('keeps assistant text and non-assistant entries', () => {
		const withText = { kind: 'assistant' as const, text: 'partial answer' };
		assert.strictEqual(dropEmptyAssistant([withText], withText), false);
		const notice = { kind: 'notice' as const, text: 'n' };
		assert.strictEqual(dropEmptyAssistant([notice], notice), false);
	});

	it('returns false when the entry is absent or already removed', () => {
		const empty = { kind: 'assistant' as const, text: '' };
		assert.strictEqual(dropEmptyAssistant([], empty), false);
		const entries = [empty];
		assert.strictEqual(dropEmptyAssistant(entries, empty), true);
		assert.strictEqual(dropEmptyAssistant(entries, empty), false);
	});
});
