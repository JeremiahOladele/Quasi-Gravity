/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	SAFE_DEFAULTS,
	permissionsForProfile,
	profileForPermissions,
	normalizeSafetyDefaults
} from '../core/safetyDefaults';

describe('normalizeSafetyDefaults', () => {
	it('returns safe defaults for empty or invalid input', () => {
		assert.deepStrictEqual(normalizeSafetyDefaults(undefined), SAFE_DEFAULTS);
		assert.deepStrictEqual(normalizeSafetyDefaults({}), SAFE_DEFAULTS);
		assert.deepStrictEqual(normalizeSafetyDefaults(null), SAFE_DEFAULTS);
	});

	it('keeps valid preset profiles and matching permissions', () => {
		const balanced = normalizeSafetyDefaults({ profile: 'balanced', permissions: { askBeforeTerminal: 'unlisted', askBeforeWriteOutsideWorkspace: true } });
		assert.strictEqual(balanced.profile, 'balanced');
		assert.strictEqual(balanced.permissions.askBeforeTerminal, 'unlisted');

		const autonomous = normalizeSafetyDefaults({ profile: 'autonomous', permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: false } });
		assert.strictEqual(autonomous.profile, 'autonomous');
	});

	it('falls back per field on invalid values', () => {
		const normalized = normalizeSafetyDefaults({ profile: 'nonsense', permissions: { askBeforeTerminal: 'sometimes', askBeforeWriteOutsideWorkspace: 'yes' } });
		assert.strictEqual(normalized.permissions.askBeforeTerminal, 'always');
		assert.strictEqual(normalized.permissions.askBeforeWriteOutsideWorkspace, true);
		assert.strictEqual(normalized.profile, 'safe');
	});

	it('derives custom when permissions no longer match the declared profile', () => {
		const normalized = normalizeSafetyDefaults({ profile: 'safe', permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: true } });
		assert.strictEqual(normalized.profile, 'custom');
	});

	it('keeps an explicit custom profile', () => {
		assert.strictEqual(normalizeSafetyDefaults({ profile: 'custom', permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: true } }).profile, 'custom');
	});

	it('derives the profile from permissions when profile is missing', () => {
		assert.strictEqual(normalizeSafetyDefaults({ permissions: { askBeforeTerminal: 'unlisted', askBeforeWriteOutsideWorkspace: true } }).profile, 'balanced');
		assert.strictEqual(normalizeSafetyDefaults({ permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: true } }).profile, 'custom');
	});
});

describe('profile helpers', () => {
	it('returns profile permissions', () => {
		assert.deepStrictEqual(permissionsForProfile('safe'), { askBeforeTerminal: 'always', askBeforeWriteOutsideWorkspace: true });
		assert.deepStrictEqual(permissionsForProfile('autonomous'), { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: false });
	});

	it('matches permissions back to a profile', () => {
		assert.strictEqual(profileForPermissions({ askBeforeTerminal: 'always', askBeforeWriteOutsideWorkspace: true }), 'safe');
		assert.strictEqual(profileForPermissions({ askBeforeTerminal: 'unlisted', askBeforeWriteOutsideWorkspace: true }), 'balanced');
		assert.strictEqual(profileForPermissions({ askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: true }), 'custom');
	});
});
