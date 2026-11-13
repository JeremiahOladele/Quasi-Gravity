/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const DIFF_MAX_LINES = 2000;
export const DIFF_MAX_CELLS = 400_000;
export const DIFF_MAX_OUTPUT_LINES = 300;
export const DIFF_TIME_BUDGET_MS = 80;

export interface DiffResult {
	/** Unified-style lines prefixed with ' ', '-' or '+'. Empty when the change is too large. */
	readonly lines: readonly string[];
	readonly added: number;
	readonly removed: number;
	/** False when the inputs were too large to diff exactly. */
	readonly statsExact: boolean;
	/** True when the visible lines were capped. */
	readonly outputTruncated: boolean;
}

export interface LineStats {
	readonly added: number;
	readonly removed: number;
	readonly exact: boolean;
}

function toLf(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

function toLines(text: string): string[] {
	const normalized = toLf(text);
	return normalized.length === 0 ? [] : normalized.split('\n');
}

/** Capped line diff. Never throws on large inputs; reports `statsExact: false` instead. */
export function computeDiff(before: string, after: string): DiffResult {
	const beforeLines = toLines(before);
	const afterLines = toLines(after);
	const n = beforeLines.length;
	const m = afterLines.length;
	if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES || (n + 1) * (m + 1) > DIFF_MAX_CELLS) {
		return { lines: [], added: 0, removed: 0, statsExact: false, outputTruncated: true };
	}
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	const start = Date.now();
	for (let i = 1; i <= n; i++) {
		if (Date.now() - start > DIFF_TIME_BUDGET_MS) {
			return { lines: [], added: 0, removed: 0, statsExact: false, outputTruncated: true };
		}
		const row = i * width;
		const prev = (i - 1) * width;
		const line = beforeLines[i - 1];
		for (let j = 1; j <= m; j++) {
			table[row + j] = line === afterLines[j - 1]
				? table[prev + j - 1] + 1
				: Math.max(table[prev + j], table[row + j - 1]);
		}
	}
	const reversed: string[] = [];
	let added = 0;
	let removed = 0;
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
			reversed.push(` ${beforeLines[i - 1]}`);
			i--;
			j--;
		} else if (j > 0 && (i === 0 || table[i * width + j - 1] >= table[(i - 1) * width + j])) {
			reversed.push(`+${afterLines[j - 1]}`);
			added++;
			j--;
		} else {
			reversed.push(`-${beforeLines[i - 1]}`);
			removed++;
			i--;
		}
	}
	reversed.reverse();
	return {
		lines: reversed.slice(0, DIFF_MAX_OUTPUT_LINES),
		added,
		removed,
		statsExact: true,
		outputTruncated: reversed.length > DIFF_MAX_OUTPUT_LINES
	};
}

export function computeLineStats(before: string, after: string): LineStats {
	if (toLf(before) === toLf(after)) {
		return { added: 0, removed: 0, exact: true };
	}
	const diff = computeDiff(before, after);
	return { added: diff.added, removed: diff.removed, exact: diff.statsExact };
}
