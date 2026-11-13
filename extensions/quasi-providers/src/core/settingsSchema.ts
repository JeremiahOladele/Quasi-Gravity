/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hostOf, validateProviderConfig } from './providerConfig';
import { ProviderConfig } from './types';

export const SETTINGS_VERSION = 1;

/**
 * Keys under `defaults` that may be imported. Empty until M5 defines the shape.
 * Everything else is dropped, so an imported file cannot set safety defaults.
 */
const KNOWN_DEFAULTS_KEYS: ReadonlySet<string> = new Set<string>();

export interface QuasiSettingsV1 {
	readonly version: 1;
	readonly providers: ProviderConfig[];
	readonly defaults: Record<string, unknown>;
	readonly activeProviderId?: string;
	readonly activeModel?: string;
}

export interface ParseSettingsResult {
	readonly ok: boolean;
	readonly value?: QuasiSettingsV1;
	readonly problems?: string[];
	readonly warnings?: string[];
}

/** Reject base URLs with embedded credentials or a query string. */
export function validateProviderBaseUrl(baseUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return 'baseUrl is not a valid URL';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'baseUrl must start with http:// or https://';
	}
	if (url.username || url.password) {
		return 'baseUrl must not contain credentials (user:pass@host)';
	}
	if (url.search) {
		return 'baseUrl must not contain a query string';
	}
	return undefined;
}

export function filterKnownDefaults(raw: unknown): { value: Record<string, unknown>; dropped: string[] } {
	const value: Record<string, unknown> = {};
	const dropped: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { value, dropped };
	}
	for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (KNOWN_DEFAULTS_KEYS.has(key)) {
			value[key] = entry;
		} else {
			dropped.push(key);
		}
	}
	return { value, dropped };
}

/** Validate a parsed `quasi-settings.json` object. Pure; never throws. */
export function parseQuasiSettings(raw: unknown): ParseSettingsResult {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, problems: ['settings file must be a JSON object'] };
	}
	const record = raw as Record<string, unknown>;
	const problems: string[] = [];
	const warnings: string[] = [];

	const version = record.version;
	if (typeof version !== 'number') {
		problems.push('version is missing or not a number');
	} else if (version !== SETTINGS_VERSION) {
		problems.push(`unsupported settings version ${version}; this build supports version ${SETTINGS_VERSION}`);
	}

	const providers: ProviderConfig[] = [];
	if (!Array.isArray(record.providers)) {
		problems.push('providers must be an array');
	} else {
		record.providers.forEach((entry, index) => {
			const validated = validateProviderConfig(entry);
			if (!validated.ok || !validated.value) {
				problems.push(`providers[${index}]: ${validated.problem ?? 'invalid entry'}`);
				return;
			}
			const baseProblem = validateProviderBaseUrl(validated.value.baseUrl);
			if (baseProblem) {
				problems.push(`providers[${index}] (${validated.value.id}): ${baseProblem}`);
				return;
			}
			providers.push(validated.value);
		});
	}

	let defaults: Record<string, unknown> = {};
	if (record.defaults !== undefined) {
		if (typeof record.defaults !== 'object' || record.defaults === null || Array.isArray(record.defaults)) {
			problems.push('defaults must be an object');
		} else {
			const filtered = filterKnownDefaults(record.defaults);
			defaults = filtered.value;
			if (filtered.dropped.length > 0) {
				warnings.push(`dropped unknown defaults key(s): ${filtered.dropped.join(', ')}`);
			}
		}
	}

	let activeProviderId: string | undefined;
	if (record.activeProviderId !== undefined) {
		if (typeof record.activeProviderId !== 'string') {
			problems.push('activeProviderId must be a string');
		} else {
			activeProviderId = record.activeProviderId;
		}
	}

	let activeModel: string | undefined;
	if (record.activeModel !== undefined) {
		if (typeof record.activeModel !== 'string') {
			problems.push('activeModel must be a string');
		} else {
			activeModel = record.activeModel;
		}
	}

	if (problems.length > 0) {
		return { ok: false, problems };
	}

	const value: QuasiSettingsV1 = {
		version: SETTINGS_VERSION,
		providers,
		defaults,
		...(activeProviderId !== undefined ? { activeProviderId } : {}),
		...(activeModel !== undefined ? { activeModel } : {}),
	};
	return { ok: true, value, warnings };
}

/** Serialize with 2-space indentation and LF line endings. */
export function serializeQuasiSettings(settings: QuasiSettingsV1): string {
	return JSON.stringify(settings, null, 2).replace(/\r\n/g, '\n');
}

const SECRET_PROPERTY = /^(api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|password|secret|authorization)$/i;
const SECRET_VALUE = /(^|[^A-Za-z0-9])(sk-or-v1-[a-f0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|xai-[A-Za-z0-9]{16,}|pplx-[A-Za-z0-9]{16,})/;

/**
 * Find paths that look like secrets (secret-named properties or key-like
 * values). Returns paths only, never values, so it is safe to show/log.
 */
export function scanForSecrets(value: unknown, path = '$'): string[] {
	const found: string[] = [];
	if (typeof value === 'string') {
		if (SECRET_VALUE.test(value)) {
			found.push(path);
		}
		return found;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => found.push(...scanForSecrets(entry, `${path}[${index}]`)));
		return found;
	}
	if (typeof value === 'object' && value !== null) {
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_PROPERTY.test(key)) {
				found.push(`${path}.${key}`);
				continue;
			}
			found.push(...scanForSecrets(entry, `${path}.${key}`));
		}
	}
	return found;
}

export interface ImportProviderSummary {
	readonly id: string;
	readonly host?: string;
}

export interface ImportConflict {
	readonly id: string;
	readonly existingHost?: string;
	readonly importedHost?: string;
}

export interface ImportPlan {
	readonly providers: ProviderConfig[];
	readonly added: ImportProviderSummary[];
	readonly updated: ImportProviderSummary[];
	readonly skipped: ImportProviderSummary[];
	readonly conflicts: ImportConflict[];
	readonly activeProviderId?: string;
	readonly activeModel?: string;
	readonly activeChanged: boolean;
}

/**
 * Merge imported providers into existing ones.
 * - New id → added.
 * - Same id, same base-URL host → updated in place (safe: no key redirection).
 * - Same id, different host → conflict; the imported entry is skipped so the
 *   existing stored key is never sent to a new host.
 */
export function planImport(
	existing: ReadonlyArray<ProviderConfig>,
	imported: ReadonlyArray<ProviderConfig>,
	currentActiveId: string | undefined,
	currentActiveModel: string | undefined,
	importedActiveId: string | undefined,
	importedActiveModel: string | undefined
): ImportPlan {
	const providers = existing.map(provider => ({ ...provider }));
	const added: ImportProviderSummary[] = [];
	const updated: ImportProviderSummary[] = [];
	const skipped: ImportProviderSummary[] = [];
	const conflicts: ImportConflict[] = [];

	for (const incoming of imported) {
		const index = providers.findIndex(provider => provider.id === incoming.id);
		if (index === -1) {
			providers.push({ ...incoming });
			added.push({ id: incoming.id, host: hostOf(incoming.baseUrl) });
			continue;
		}

		const current = providers[index];
		const existingHost = hostOf(current.baseUrl);
		const importedHost = hostOf(incoming.baseUrl);
		if (existingHost !== importedHost) {
			conflicts.push({ id: incoming.id, existingHost, importedHost });
			skipped.push({ id: incoming.id, host: importedHost });
			continue;
		}

		providers[index] = { ...incoming, id: current.id };
		updated.push({ id: current.id, host: importedHost });
	}

	let activeProviderId = currentActiveId;
	let activeModel = currentActiveModel;
	if (importedActiveId && providers.some(provider => provider.id === importedActiveId)) {
		if (importedActiveId !== currentActiveId) {
			activeProviderId = importedActiveId;
			// The old model belonged to the previous provider; do not carry it over.
			activeModel = importedActiveModel;
		} else if (importedActiveModel !== undefined) {
			activeModel = importedActiveModel;
		}
	}

	return {
		providers,
		added,
		updated,
		skipped,
		conflicts,
		...(activeProviderId !== undefined ? { activeProviderId } : {}),
		...(activeModel !== undefined ? { activeModel } : {}),
		activeChanged: activeProviderId !== currentActiveId || activeModel !== currentActiveModel,
	};
}
