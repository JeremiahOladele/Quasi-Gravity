/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Best-effort detection of a provider from the shape of an API key.
 *
 * These are HINTS ONLY. The caller must still show a confirmation that names the
 * host the key will be sent to, and must never try the key against multiple
 * providers. The key itself is never returned, logged, or echoed.
 *
 * Only the OpenRouter prefix is verified against official documentation
 * (`sk-or-v1-` + 64 lowercase hex). The others are widely established but not
 * documented; presets label their detection as unverified.
 */

interface KeyRule {
	readonly prefix: string;
	readonly providerIds: ReadonlyArray<string>;
}

// Longest prefix wins, so `sk-or-v1-` is not treated as the ambiguous `sk-`.
const KEY_RULES: ReadonlyArray<KeyRule> = [
	{ prefix: 'sk-or-v1-', providerIds: ['openrouter'] },
	{ prefix: 'sk-ant-', providerIds: ['anthropic'] },
	{ prefix: 'sk-proj-', providerIds: ['openai'] },
	{ prefix: 'gsk_', providerIds: ['groq'] },
	{ prefix: 'xai-', providerIds: ['xai'] },
	{ prefix: 'fw_', providerIds: ['fireworks'] },
	{ prefix: 'AIza', providerIds: ['gemini'] },
	{ prefix: 'sk-', providerIds: ['openai', 'deepseek', 'moonshot'] },
];

const RULES_BY_LENGTH = [...KEY_RULES].sort((a, b) => b.prefix.length - a.prefix.length);

/** Trim surrounding whitespace/newlines that are commonly picked up when pasting. */
export function normalizeKey(rawKey: string): string {
	return rawKey.trim();
}

/**
 * Return the candidate preset ids for a key, or an empty array if unknown.
 * Multiple ids means the prefix is ambiguous and the user must choose.
 */
export function detectProviderIdsForKey(rawKey: string): string[] {
	const key = normalizeKey(rawKey);
	if (key.length === 0) {
		return [];
	}
	for (const rule of RULES_BY_LENGTH) {
		if (key.startsWith(rule.prefix)) {
			return [...rule.providerIds];
		}
	}
	return [];
}
