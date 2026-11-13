/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ConversationEntry, toProviderMessages } from '../core/messages';

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
