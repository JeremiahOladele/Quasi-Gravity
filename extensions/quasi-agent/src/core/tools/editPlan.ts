/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { computeLineStats } from './diff';

export interface EditSpec {
	readonly oldText: string;
	readonly newText: string;
}

export type EditPlanResult =
	| {
		readonly ok: true;
		readonly text: string;
		readonly replacements: number;
		readonly addedLines: number;
		readonly removedLines: number;
		readonly statsExact: boolean;
	}
	| { readonly ok: false; readonly error: string };

export type Eol = '\r\n' | '\n';

export function toLf(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

export function detectEol(text: string): Eol {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

export function convertEol(text: string, eol: Eol): string {
	const normalized = toLf(text);
	return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}

/**
 * Applies exact-match edits all-or-nothing. Matching is done on LF-normalized
 * text so a model that emits LF can match a CRLF file; the result keeps the
 * original file EOL.
 */
export function planEdits(content: string, edits: readonly EditSpec[]): EditPlanResult {
	if (edits.length === 0) {
		return { ok: false, error: 'No edits were provided.' };
	}
	const eol = detectEol(content);
	let working = toLf(content);
	for (let index = 0; index < edits.length; index++) {
		const oldText = toLf(edits[index].oldText);
		const newText = toLf(edits[index].newText);
		const label = `Edit ${index + 1}`;
		if (oldText.length === 0) {
			return { ok: false, error: `${label}: oldText must not be empty.` };
		}
		const first = working.indexOf(oldText);
		if (first === -1) {
			return { ok: false, error: `${label}: oldText was not found. Read the file first and copy it exactly (including indentation).` };
		}
		if (working.indexOf(oldText, first + 1) !== -1) {
			return { ok: false, error: `${label}: oldText matches more than once. Include more surrounding context to make it unique.` };
		}
		working = working.slice(0, first) + newText + working.slice(first + oldText.length);
	}
	const stats = computeLineStats(toLf(content), working);
	return {
		ok: true,
		text: eol === '\n' ? working : working.replace(/\n/g, '\r\n'),
		replacements: edits.length,
		addedLines: stats.added,
		removedLines: stats.removed,
		statsExact: stats.exact
	};
}

export interface NewFileOptions {
	/** Explicit `files.eol` setting, when the user set it. */
	readonly configuredEol?: '\r\n' | '\n' | 'auto' | 'autoEndOfLine';
}

/** New files default to LF everywhere unless `files.eol` was explicitly set. */
export function newFileText(content: string, options: NewFileOptions = {}): string {
	const eol: Eol = options.configuredEol === '\r\n' ? '\r\n' : '\n';
	return convertEol(content, eol);
}
