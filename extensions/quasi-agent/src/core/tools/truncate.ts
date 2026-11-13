/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const TRUNCATION_MARKER = '\n[output truncated]';
export const HISTORY_OMITTED_MARKER = '[older result omitted]';

export interface TruncateResult {
	readonly text: string;
	readonly truncated: boolean;
}

/** Truncate to `maxChars` code units and append a clear marker. */
export function truncateText(text: string, maxChars: number): TruncateResult {
	const limit = Math.max(0, Math.floor(maxChars));
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, limit) + TRUNCATION_MARKER, truncated: true };
}

/** Total character count of message contents (used for the history budget). */
export function totalContentLength(messages: ReadonlyArray<{ readonly content: string }>): number {
	let total = 0;
	for (const message of messages) {
		total += message.content.length;
	}
	return total;
}
