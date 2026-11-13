/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { detectProviderIdsForKey, normalizeKey } from '../core/keyDetect';

const OPENROUTER_KEY = 'sk-or-v1-' + 'a'.repeat(64);

describe('normalizeKey', () => {
	it('trims whitespace and newlines', () => {
		assert.strictEqual(normalizeKey('  sk-abc\n'), 'sk-abc');
		assert.strictEqual(normalizeKey('\t\n '), '');
	});
});

describe('detectProviderIdsForKey', () => {
	it('detects an unambiguous documented prefix (OpenRouter)', () => {
		assert.deepStrictEqual(detectProviderIdsForKey(OPENROUTER_KEY), ['openrouter']);
	});

	it('detects other single-candidate prefixes', () => {
		assert.deepStrictEqual(detectProviderIdsForKey('sk-ant-api03-xyz'), ['anthropic']);
		assert.deepStrictEqual(detectProviderIdsForKey('sk-proj-xyz'), ['openai']);
		assert.deepStrictEqual(detectProviderIdsForKey('gsk_xyz'), ['groq']);
		assert.deepStrictEqual(detectProviderIdsForKey('xai-xyz'), ['xai']);
		assert.deepStrictEqual(detectProviderIdsForKey('fw_xyz'), ['fireworks']);
		assert.deepStrictEqual(detectProviderIdsForKey('AIzaSyXyz'), ['gemini']);
	});

	it('returns multiple candidates for the ambiguous sk- prefix', () => {
		assert.deepStrictEqual(detectProviderIdsForKey('sk-abcdef'), ['openai', 'deepseek', 'moonshot']);
	});

	it('prefers the longest matching prefix', () => {
		// OpenRouter keys start with sk-, but must resolve only to OpenRouter.
		assert.deepStrictEqual(detectProviderIdsForKey(OPENROUTER_KEY), ['openrouter']);
	});

	it('trims surrounding whitespace before detecting', () => {
		assert.deepStrictEqual(detectProviderIdsForKey(`\n  ${OPENROUTER_KEY}  \n`), ['openrouter']);
	});

	it('returns an empty array for unknown or empty input', () => {
		assert.deepStrictEqual(detectProviderIdsForKey('totally-unknown'), []);
		assert.deepStrictEqual(detectProviderIdsForKey(''), []);
		assert.deepStrictEqual(detectProviderIdsForKey('   \n'), []);
	});

	it('never includes the key in its output', () => {
		assert.ok(!JSON.stringify(detectProviderIdsForKey(OPENROUTER_KEY)).includes(OPENROUTER_KEY));
		assert.ok(!JSON.stringify(detectProviderIdsForKey('sk-abcdef')).includes('sk-abcdef'));
	});
});
