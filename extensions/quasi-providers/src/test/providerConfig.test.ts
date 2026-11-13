/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	hostOf,
	isInsecureRemoteUrl,
	isLocalHost,
	providerKeyId,
	readProvidersSafe,
	slugify,
	uniqueProviderId,
	updateProvider,
	validateProviderConfig
} from '../core/providerConfig';
import { providerPresets } from '../core/providers/presets';
import { ProviderConfig } from '../core/types';

const validConfig: ProviderConfig = {
	id: 'deepseek',
	name: 'DeepSeek',
	kind: 'cloud',
	apiType: 'openai-compat',
	baseUrl: 'https://api.deepseek.com',
	defaultModel: 'deepseek-chat',
	requiresKey: true
};

describe('slugify', () => {
	it('lowercases and dashes non-alphanumerics', () => {
		assert.strictEqual(slugify('My Provider!'), 'my-provider');
		assert.strictEqual(slugify('  LM Studio  '), 'lm-studio');
	});
	it('falls back when nothing is usable', () => {
		assert.strictEqual(slugify('!!!'), 'provider');
	});
});

describe('uniqueProviderId', () => {
	it('returns the base when free', () => {
		assert.strictEqual(uniqueProviderId('ollama', []), 'ollama');
	});
	it('appends a numeric suffix on collision', () => {
		assert.strictEqual(uniqueProviderId('ollama', ['ollama']), 'ollama-2');
		assert.strictEqual(uniqueProviderId('ollama', ['ollama', 'ollama-2']), 'ollama-3');
	});
});

describe('providerKeyId', () => {
	it('namespaces the secret under quasi.key.<id>', () => {
		assert.strictEqual(providerKeyId('deepseek'), 'quasi.key.deepseek');
	});
});

describe('validateProviderConfig', () => {
	it('accepts a valid config', () => {
		const result = validateProviderConfig(validConfig);
		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.value, validConfig);
	});
	it('rejects non-objects', () => {
		assert.strictEqual(validateProviderConfig('nope').ok, false);
	});
	it('names the invalid fields', () => {
		const result = validateProviderConfig({ id: '', name: 'X', kind: 'weird', apiType: 'openai-compat', baseUrl: '', requiresKey: 'yes' });
		assert.strictEqual(result.ok, false);
		assert.match(result.problem ?? '', /id/);
		assert.match(result.problem ?? '', /kind/);
		assert.match(result.problem ?? '', /baseUrl/);
		assert.match(result.problem ?? '', /requiresKey/);
	});
});

describe('readProvidersSafe', () => {
	it('keeps valid entries and reports invalid ones without throwing', () => {
		const result = readProvidersSafe([validConfig, { id: 'broken' }, { name: 'no-id' }, 42]);
		assert.strictEqual(result.providers.length, 1);
		assert.strictEqual(result.providers[0].id, 'deepseek');
		assert.strictEqual(result.problems.length, 3);
		assert.ok(result.problems.some(p => p.includes('broken')));
	});
	it('handles non-array values', () => {
		assert.deepStrictEqual(readProvidersSafe(undefined), { providers: [], problems: [] });
		assert.strictEqual(readProvidersSafe({}).problems.length, 1);
	});
});

describe('updateProvider', () => {
	it('never changes the id', () => {
		const patch = { name: 'Renamed', id: 'hacked' } as unknown as Partial<Omit<ProviderConfig, 'id'>>;
		const updated = updateProvider([validConfig], 'deepseek', patch);
		assert.strictEqual(updated[0].id, 'deepseek');
		assert.strictEqual(updated[0].name, 'Renamed');
	});
});

describe('isLocalHost', () => {
	it('is loopback only', () => {
		assert.strictEqual(isLocalHost('localhost'), true);
		assert.strictEqual(isLocalHost('127.0.0.1'), true);
		assert.strictEqual(isLocalHost('::1'), true);
		assert.strictEqual(isLocalHost('[::1]'), true);
		assert.strictEqual(isLocalHost('192.168.1.5'), false);
		assert.strictEqual(isLocalHost('example.com'), false);
		assert.strictEqual(isLocalHost('0.0.0.0'), false);
	});
});

describe('isInsecureRemoteUrl', () => {
	it('warns for plain HTTP to non-loopback hosts', () => {
		assert.strictEqual(isInsecureRemoteUrl('http://example.com/v1'), true);
		assert.strictEqual(isInsecureRemoteUrl('http://192.168.1.5:8080/v1'), true);
	});
	it('does not warn for HTTPS or loopback', () => {
		assert.strictEqual(isInsecureRemoteUrl('https://example.com/v1'), false);
		assert.strictEqual(isInsecureRemoteUrl('http://localhost:11434/v1'), false);
		assert.strictEqual(isInsecureRemoteUrl('http://127.0.0.1:1234/v1'), false);
	});
	it('returns false for unparseable URLs', () => {
		assert.strictEqual(isInsecureRemoteUrl('not a url'), false);
	});
});

describe('hostOf', () => {
	it('extracts a lowercase hostname', () => {
		assert.strictEqual(hostOf('https://API.Example.com/v1'), 'api.example.com');
		assert.strictEqual(hostOf('nonsense'), undefined);
	});
});

describe('providerPresets', () => {
	it('marks local presets as keyless', () => {
		for (const preset of providerPresets) {
			if (preset.config.kind === 'local') {
				assert.strictEqual(preset.config.requiresKey, false, preset.label);
			}
		}
	});
});
