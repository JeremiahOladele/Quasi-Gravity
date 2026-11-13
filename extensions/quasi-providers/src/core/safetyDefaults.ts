/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TerminalPermission = 'always' | 'unlisted' | 'never';

export type SafetyProfile = 'safe' | 'balanced' | 'autonomous' | 'custom';

export interface SafetyPermissions {
	/**
	 * - `always`: prompt before every terminal command.
	 * - `unlisted`: run allowlisted commands without asking, prompt otherwise.
	 *   Phase 2 defines the allowlist; until then this behaves like `always`.
	 * - `never`: run terminal commands without asking.
	 */
	readonly askBeforeTerminal: TerminalPermission;
	readonly askBeforeWriteOutsideWorkspace: boolean;
}

export interface SafetyDefaults {
	readonly permissions: SafetyPermissions;
	readonly profile: SafetyProfile;
}

export interface SafetyProfileDefinition {
	readonly id: 'safe' | 'balanced' | 'autonomous';
	readonly label: string;
	readonly description: string;
	readonly permissions: SafetyPermissions;
}

/** Presets that fill in permissions. `custom` is not a preset. */
export const SAFETY_PROFILES: ReadonlyArray<SafetyProfileDefinition> = [
	{
		id: 'safe',
		label: 'Safe',
		description: 'Ask before terminal commands and before writing outside the workspace.',
		permissions: { askBeforeTerminal: 'always', askBeforeWriteOutsideWorkspace: true }
	},
	{
		id: 'balanced',
		label: 'Balanced',
		description: 'Allowlisted terminal commands run without asking (none yet, so this prompts); writes outside the workspace still prompt.',
		permissions: { askBeforeTerminal: 'unlisted', askBeforeWriteOutsideWorkspace: true }
	},
	{
		id: 'autonomous',
		label: 'Autonomous',
		description: 'Run terminal commands and write outside the workspace without asking.',
		permissions: { askBeforeTerminal: 'never', askBeforeWriteOutsideWorkspace: false }
	},
];

export const SAFE_DEFAULTS: SafetyDefaults = {
	permissions: { askBeforeTerminal: 'always', askBeforeWriteOutsideWorkspace: true },
	profile: 'safe'
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalPermission(value: unknown): value is TerminalPermission {
	return value === 'always' || value === 'unlisted' || value === 'never';
}

function isProfilePreset(value: unknown): value is 'safe' | 'balanced' | 'autonomous' {
	return value === 'safe' || value === 'balanced' || value === 'autonomous';
}

function isSafetyProfile(value: unknown): value is SafetyProfile {
	return isProfilePreset(value) || value === 'custom';
}

function samePermissions(a: SafetyPermissions, b: SafetyPermissions): boolean {
	return a.askBeforeTerminal === b.askBeforeTerminal
		&& a.askBeforeWriteOutsideWorkspace === b.askBeforeWriteOutsideWorkspace;
}

export function permissionsForProfile(profile: 'safe' | 'balanced' | 'autonomous'): SafetyPermissions {
	const definition = SAFETY_PROFILES.find(entry => entry.id === profile);
	return { ...(definition ? definition.permissions : SAFE_DEFAULTS.permissions) };
}

/** The preset a permission set matches, or `custom` if it matches none. */
export function profileForPermissions(permissions: SafetyPermissions): SafetyProfile {
	const match = SAFETY_PROFILES.find(definition => samePermissions(definition.permissions, permissions));
	return match ? match.id : 'custom';
}

/**
 * Validate `quasi.defaults`. Invalid values fall back to safe defaults per
 * field; this never throws. If the stored profile no longer matches the stored
 * permissions, the profile becomes `custom`.
 */
export function normalizeSafetyDefaults(raw: unknown): SafetyDefaults {
	const record = isObject(raw) ? raw : {};
	const permissionsRecord = isObject(record.permissions) ? record.permissions : {};

	const askBeforeTerminal = isTerminalPermission(permissionsRecord.askBeforeTerminal)
		? permissionsRecord.askBeforeTerminal
		: SAFE_DEFAULTS.permissions.askBeforeTerminal;
	const askBeforeWriteOutsideWorkspace = typeof permissionsRecord.askBeforeWriteOutsideWorkspace === 'boolean'
		? permissionsRecord.askBeforeWriteOutsideWorkspace
		: SAFE_DEFAULTS.permissions.askBeforeWriteOutsideWorkspace;
	const permissions: SafetyPermissions = { askBeforeTerminal, askBeforeWriteOutsideWorkspace };

	let profile: SafetyProfile;
	if (isSafetyProfile(record.profile)) {
		profile = record.profile === 'custom'
			? 'custom'
			: (samePermissions(permissionsForProfile(record.profile), permissions) ? record.profile : 'custom');
	} else {
		profile = profileForPermissions(permissions);
	}

	return { permissions, profile };
}
