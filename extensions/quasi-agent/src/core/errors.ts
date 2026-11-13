/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HostErrorKind } from './protocol';

export interface ChatFailure {
	/** Already-redacted message from the provider adapter. */
	readonly message: string;
	readonly status?: number;
}

export interface ClassifiedChatError {
	readonly kind: HostErrorKind;
	readonly message: string;
}

/**
 * Classify a chat failure. `offline` is reserved for network failures (no HTTP
 * status); 429 is rate-limited; 5xx and other statuses are provider errors.
 */
export function classifyChatError(failure: ChatFailure): ClassifiedChatError {
	if (failure.status === 401 || failure.status === 403) {
		return { kind: 'key-rejected', message: 'The API key was rejected by the provider.' };
	}
	if (failure.status === 429) {
		return { kind: 'rate-limited', message: 'The provider is rate-limiting requests. Try again shortly.' };
	}
	if (failure.status === undefined) {
		return { kind: 'offline', message: 'Could not reach the provider. Check that it is running and reachable.' };
	}
	return { kind: 'provider-error', message: failure.message || `The provider returned an error (HTTP ${failure.status}).` };
}
