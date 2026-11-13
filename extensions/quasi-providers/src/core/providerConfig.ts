/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiType, ProviderConfig, ProviderKind } from './types';

const KINDS: ReadonlyArray<ProviderKind> = ['cloud', 'local', 'remote'];
const API_TYPES: ReadonlyArray<ApiType> = ['openai-compat', 'ollama', 'anthropic', 'gemini'];

/** Turn a display name into a stable slug (lowercase, dashes). */
export function slugify(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || 'provider';
}

/** Return a slug not already used by `existingIds` (appends -2, -3, ...). */
export function uniqueProviderId(base: string, existingIds: ReadonlyArray<string>): string {
	const taken = new Set(existingIds);
	if (!taken.has(base)) {
		return base;
	}
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) {
		suffix++;
	}
	return `${base}-${suffix}`;
}

/** SecretStorage key for a provider's API key. Never store keys in settings. */
export function providerKeyId(id: string): string {
	return `quasi.key.${id}`;
}

export function findProvider(providers: ReadonlyArray<ProviderConfig>, id: string): ProviderConfig | undefined {
	return providers.find(provider => provider.id === id);
}

export function addProvider(providers: ReadonlyArray<ProviderConfig>, config: ProviderConfig): ProviderConfig[] {
	return [...providers, config];
}

/** Update editable fields of a provider. `id` is always preserved (never changed). */
export function updateProvider(providers: ReadonlyArray<ProviderConfig>, id: string, patch: Partial<Omit<ProviderConfig, 'id'>>): ProviderConfig[] {
	return providers.map(provider => provider.id === id ? { ...provider, ...patch, id: provider.id } : provider);
}

export function removeProvider(providers: ReadonlyArray<ProviderConfig>, id: string): ProviderConfig[] {
	return providers.filter(provider => provider.id !== id);
}

export interface ProviderValidationResult {
	readonly ok: boolean;
	readonly value?: ProviderConfig;
	readonly problem?: string;
}

/** Validate one raw settings entry. Pure: never throws. */
export function validateProviderConfig(raw: unknown): ProviderValidationResult {
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, problem: 'entry is not an object' };
	}
	const record = raw as Record<string, unknown>;
	const problems: string[] = [];
	if (typeof record.id !== 'string' || record.id.length === 0) { problems.push('id'); }
	if (typeof record.name !== 'string' || record.name.length === 0) { problems.push('name'); }
	if (typeof record.kind !== 'string' || !KINDS.includes(record.kind as ProviderKind)) { problems.push('kind'); }
	if (typeof record.apiType !== 'string' || !API_TYPES.includes(record.apiType as ApiType)) { problems.push('apiType'); }
	if (typeof record.baseUrl !== 'string' || record.baseUrl.length === 0) { problems.push('baseUrl'); }
	if (typeof record.requiresKey !== 'boolean') { problems.push('requiresKey'); }
	if (problems.length > 0) {
		return { ok: false, problem: `invalid or missing field(s): ${problems.join(', ')}` };
	}
	const value: ProviderConfig = {
		id: record.id as string,
		name: record.name as string,
		kind: record.kind as ProviderKind,
		apiType: record.apiType as ApiType,
		baseUrl: record.baseUrl as string,
		requiresKey: record.requiresKey as boolean,
	};
	if (typeof record.defaultModel === 'string') {
		value.defaultModel = record.defaultModel;
	}
	if (record.capabilities !== undefined && typeof record.capabilities === 'object' && record.capabilities !== null) {
		value.capabilities = record.capabilities as ProviderConfig['capabilities'];
	}
	return { ok: true, value };
}

export interface ProvidersReadResult {
	readonly providers: ProviderConfig[];
	readonly problems: string[];
}

/**
 * Validate a raw `quasi.providers` value, skipping (and reporting) invalid
 * entries. Never throws, so callers can use it during activation or in the
 * status bar without risking a crash.
 */
export function readProvidersSafe(raw: unknown): ProvidersReadResult {
	const providers: ProviderConfig[] = [];
	const problems: string[] = [];
	if (raw === undefined || raw === null) {
		return { providers, problems };
	}
	if (!Array.isArray(raw)) {
		return { providers, problems: ['quasi.providers is not an array; ignoring it.'] };
	}
	for (let index = 0; index < raw.length; index++) {
		const entry = raw[index];
		const result = validateProviderConfig(entry);
		if (result.ok && result.value) {
			providers.push(result.value);
		} else {
			const label = typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string'
				? (entry as { id: string }).id
				: `#${index + 1}`;
			problems.push(`Skipped provider '${label}': ${result.problem ?? 'invalid entry'}`);
		}
	}
	return { providers, problems };
}

/** Loopback only: localhost, 127.0.0.1, ::1. LAN/private addresses are not local. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** True for a plain (non-HTTPS) URL whose host is not loopback. */
export function isInsecureRemoteUrl(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') {
		return false;
	}
	return !isLocalHost(url.hostname);
}

/** Extract the hostname of a base URL, or undefined if it cannot be parsed. */
export function hostOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}
