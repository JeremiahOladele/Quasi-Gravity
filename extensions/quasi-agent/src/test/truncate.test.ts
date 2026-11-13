/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { HISTORY_OMITTED_MARKER, TRUNCATION_MARKER, totalContentLength, truncateText } from '../core/tools/truncate';

describe('truncateText', () => {
	it('leaves short text unchanged', () => {
		assert.deepStrictEqual(truncateText('hello', 10), { text: 'hello', truncated: false });
	});

	it('truncates with a clear marker', () => {
		const result = truncateText('abcdef', 3);
		assert.strictEqual(result.truncated, true);
		assert.strictEqual(result.text, 'abc' + TRUNCATION_MARKER);
	});

	it('handles a zero limit', () => {
		assert.deepStrictEqual(truncateText('abc', 0), { text: TRUNCATION_MARKER, truncated: true });
	});
});

describe('totalContentLength', () => {
	it('sums content lengths', () => {
		assert.strictEqual(totalContentLength([{ content: 'abc' }, { content: 'de' }]), 5);
	});

	it('exposes the history marker', () => {
		assert.strictEqual(HISTORY_OMITTED_MARKER, '[older result omitted]');
	});
});
