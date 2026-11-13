/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { redactSecrets } from './redact';

/**
 * Descriptor for a free, authenticated endpoint that validates an API key
 * (for example a key-info or balance endpoint). Pure data; no secrets.
 */
export interface KeyCheck {
	readonly url: string;
}

export type KeyCheckStatus = 'verified' | 'rejected' | 'unknown';

export interface KeyCheckResult {
	readonly status: KeyCheckStatus;
	/** Redacted detail (never contains the key). */
	readonly detail?: string;
}

/**
 * Check a key against an optional authenticated endpoint.
 *
 * - No descriptor: `unknown` (the provider has no known key-info endpoint, so a
 *   public model list cannot confirm the key).
 * - 2xx: `verified`. 401/403: `rejected`. Anything else/network error: `unknown`.
 *
 * The key is never returned, logged, or placed in `detail`.
 */
export async function checkApiKey(keyCheck: KeyCheck | undefined, key: string, signal?: AbortSignal): Promise<KeyCheckResult> {
	if (!keyCheck) {
		return { status: 'unknown' };
	}

	let res: Response;
	try {
		res = await fetch(keyCheck.url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${key}` },
			signal,
		});
	} catch (err) {
		return { status: 'unknown', detail: redactSecrets(errorMessage(err), key) };
	}

	if (res.status >= 200 && res.status < 300) {
		return { status: 'verified' };
	}
	if (res.status === 401 || res.status === 403) {
		return { status: 'rejected', detail: `HTTP ${res.status}` };
	}
	return { status: 'unknown', detail: `HTTP ${res.status}` };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
