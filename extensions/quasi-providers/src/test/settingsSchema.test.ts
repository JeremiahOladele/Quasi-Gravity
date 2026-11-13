/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	QuasiSettingsV1,
	parseQuasiSettings,
	planImport,
	scanForSecrets,
	serializeQuasiSettings,
	validateProviderBaseUrl
} from '../core/settingsSchema';
import { ProviderConfig } from '../core/types';

function provider(id: string, baseUrl: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id,
		name: id,
		kind: 'cloud',
		apiType: 'openai-compat',
		baseUrl,
		requiresKey: true,
		...overrides
	};
}

function settings(overrides: Partial<QuasiSettingsV1> = {}): QuasiSettingsV1 {
	return {
		version: 1,
		providers: [provider('p', 'https://api.example.com/v1')],
		defaults: {},
		activeProviderId: 'p',
		activeModel: 'm',
		...overrides
	};
}

describe('validateProviderBaseUrl', () => {
	it('accepts plain http(s) URLs', () => {
		assert.strictEqual(validateProviderBaseUrl('https://api.example.com/v1'), undefined);
		assert.strictEqual(validateProviderBaseUrl('http://localhost:11434/v1'), undefined);
	});
	it('rejects credentials and query strings', () => {
		assert.match(validateProviderBaseUrl('https://user:pass@api.example.com/v1') ?? '', /credentials/);
		assert.match(validateProviderBaseUrl('https://api.example.com/v1?x=1') ?? '', /query string/);
	});
});

describe('parseQuasiSettings', () => {
	it('accepts a valid v1 file', () => {
		const parsed = parseQuasiSettings(settings());
		assert.strictEqual(parsed.ok, true);
		assert.deepStrictEqual(parsed.value, settings());
	});

	it('rejects an unknown future version', () => {
		const parsed = parseQuasiSettings({ version: 2, providers: [] });
		assert.strictEqual(parsed.ok, false);
		assert.ok(parsed.problems?.some(problem => problem.includes('unsupported settings version 2')));
	});

	it('rejects a missing version', () => {
		const parsed = parseQuasiSettings({ providers: [] });
		assert.strictEqual(parsed.ok, false);
		assert.ok(parsed.problems?.some(problem => problem.includes('version')));
	});

	it('reports invalid provider fields with the index', () => {
		const parsed = parseQuasiSettings({ version: 1, providers: [{ id: 'x' }] });
		assert.strictEqual(parsed.ok, false);
		assert.ok(parsed.problems?.some(problem => problem.startsWith('providers[0]')));
	});

	it('rejects credential and query base URLs', () => {
		const credentials = parseQuasiSettings({ version: 1, providers: [provider('p', 'https://u:p@host/v1')] });
		assert.strictEqual(credentials.ok, false);
		const query = parseQuasiSettings({ version: 1, providers: [provider('p', 'https://host/v1?x=1')] });
		assert.strictEqual(query.ok, false);
	});

	it('drops unknown defaults keys and warns', () => {
		const parsed = parseQuasiSettings({ version: 1, providers: [], defaults: { safety: { x: 1 }, foo: 2 } });
		assert.strictEqual(parsed.ok, true);
		assert.deepStrictEqual(parsed.value?.defaults, {});
		assert.ok(parsed.warnings?.some(warning => warning.includes('safety') && warning.includes('foo')));
	});

	it('never imports permissions or the profile from defaults', () => {
		const parsed = parseQuasiSettings({
			version: 1,
			providers: [],
			defaults: { permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: false }, profile: 'autonomous' }
		});
		assert.strictEqual(parsed.ok, true);
		assert.deepStrictEqual(parsed.value?.defaults, {});
		assert.ok(parsed.warnings?.some(warning => warning.includes('permissions') && warning.includes('profile')));
	});

	it('serializes with LF and round-trips', () => {
		const text = serializeQuasiSettings(settings());
		assert.ok(!text.includes('\r'));
		const parsed = parseQuasiSettings(JSON.parse(text));
		assert.deepStrictEqual(parsed.value, settings());
	});

	it('does not serialize a defaults field when it is omitted', () => {
		const text = serializeQuasiSettings({ version: 1, providers: [] });
		assert.ok(!text.includes('"defaults"'));
	});
});

describe('scanForSecrets', () => {
	it('finds nothing in a clean settings object', () => {
		assert.deepStrictEqual(scanForSecrets(settings()), []);
	});
	it('finds secret-named properties and key-like values without returning values', () => {
		assert.deepStrictEqual(scanForSecrets({ provider: { key: 'anything' } }), ['$.provider.key']);
		const found = scanForSecrets({ value: 'sk-abcdefghijklmnop' });
		assert.deepStrictEqual(found, ['$.value']);
		assert.ok(!JSON.stringify(found).includes('abcdefghijklmnop'));
	});
});

describe('planImport', () => {
	const existing = [provider('p', 'https://api.example.com/v1', { name: 'Existing' })];

	it('adds a provider with a new id', () => {
		const plan = planImport(existing, [provider('q', 'https://other.example.com/v1')], undefined, undefined, undefined, undefined);
		assert.strictEqual(plan.added.length, 1);
		assert.strictEqual(plan.providers.length, 2);
	});

	it('updates in place when the host matches', () => {
		const plan = planImport(existing, [provider('p', 'https://api.example.com/v1', { name: 'Updated' })], 'p', 'm', undefined, undefined);
		assert.strictEqual(plan.updated.length, 1);
		assert.strictEqual(plan.conflicts.length, 0);
		assert.strictEqual(plan.providers.length, 1);
		assert.strictEqual(plan.providers[0].name, 'Updated');
	});

	it('reports a conflict when the host differs and keeps the existing provider', () => {
		const plan = planImport(existing, [provider('p', 'https://evil.example.com/v1')], 'p', 'm', undefined, undefined);
		assert.strictEqual(plan.conflicts.length, 1);
		assert.strictEqual(plan.conflicts[0].existingHost, 'api.example.com');
		assert.strictEqual(plan.conflicts[0].importedHost, 'evil.example.com');
		assert.strictEqual(plan.providers.length, 1);
		assert.strictEqual(plan.providers[0].baseUrl, 'https://api.example.com/v1');
	});

	it('applies imported active ids only when the provider exists', () => {
		const applied = planImport(existing, [], 'p', 'old', 'p', 'new');
		assert.strictEqual(applied.activeProviderId, 'p');
		assert.strictEqual(applied.activeModel, 'new');

		const missing = planImport(existing, [], 'p', 'old', 'ghost', 'new');
		assert.strictEqual(missing.activeProviderId, 'p');
		assert.strictEqual(missing.activeModel, 'old');
	});

	it('clears the model when the imported active provider changes without a model', () => {
		const two = [provider('p', 'https://a.example.com/v1'), provider('q', 'https://b.example.com/v1')];
		const plan = planImport(two, [], 'p', 'old', 'q', undefined);
		assert.strictEqual(plan.activeProviderId, 'q');
		assert.strictEqual(plan.activeModel, undefined);
	});
});
