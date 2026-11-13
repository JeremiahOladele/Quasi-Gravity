/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildSystemPrompt } from '../core/prompt';

describe('buildSystemPrompt', () => {
	it('includes environment values and tool guidance', () => {
		const text = buildSystemPrompt({
			date: '2026-11-13',
			os: 'linux',
			shell: 'bash',
			workspaceName: 'demo',
			tools: ['list_dir', 'read_file', 'search']
		});
		for (const value of ['2026-11-13', 'linux', 'bash', 'demo', 'list_dir', 'read_file', 'search']) {
			assert.ok(text.includes(value), `expected prompt to include ${value}`);
		}
		assert.ok(text.toLowerCase().includes('untrusted'));
		assert.ok(text.includes('random token'));
		assert.ok(!text.includes('/home/'));
	});

	it('states when tools are unavailable', () => {
		const text = buildSystemPrompt({
			date: 'd',
			os: 'o',
			shell: 's',
			workspaceName: 'w',
			tools: [],
			toolsDisabledReason: 'the workspace is not trusted'
		});
		assert.ok(text.includes('not trusted'));
		assert.ok(text.includes('plain chat'));
		assert.ok(text.toLowerCase().includes('untrusted'));
	});

	it('states plain chat when no tools are offered', () => {
		const text = buildSystemPrompt({ date: 'd', os: 'o', shell: 's', workspaceName: 'w', tools: [] });
		assert.ok(text.includes('plain chat'));
	});
});
