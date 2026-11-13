/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Desktop-only helper: resolving real paths lets us treat symlinks whose target
// leaves the workspace as outside the sandbox (approval required). The web
// version will provide its own implementation behind the same checks.

import * as fs from 'fs/promises';
import * as path from 'path';

export async function realPathOrUndefined(target: string): Promise<string | undefined> {
	try {
		return await fs.realpath(target);
	} catch {
		return undefined;
	}
}

export function isPathInside(root: string, candidate: string, caseInsensitive: boolean): boolean {
	const candidateValue = caseInsensitive ? candidate.toLowerCase() : candidate;
	const rootValue = caseInsensitive ? root.toLowerCase() : root;
	return candidateValue === rootValue || candidateValue.startsWith(rootValue.endsWith(path.sep) ? rootValue : rootValue + path.sep);
}

/** True when the candidate exists and its real path resolves outside the root. */
export async function isRealPathOutside(root: string, candidate: string, caseInsensitive: boolean): Promise<boolean> {
	const realRoot = await realPathOrUndefined(root);
	const realCandidate = await realPathOrUndefined(candidate);
	if (!realRoot || !realCandidate) {
		return false;
	}
	return !isPathInside(realRoot, realCandidate, caseInsensitive);
}

/**
 * Real path for a write target that may not exist yet: resolves the nearest
 * existing ancestor and re-appends the missing segments.
 */
export async function realPathForWrite(target: string): Promise<string | undefined> {
	let current = target;
	const missing: string[] = [];
	while (true) {
		const real = await realPathOrUndefined(current);
		if (real) {
			return missing.length > 0 ? path.join(real, ...missing) : real;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		missing.unshift(path.basename(current));
		current = parent;
	}
}

/** True when the write target (existing or not) resolves outside the root. */
export async function isWriteTargetOutside(root: string, candidate: string, caseInsensitive: boolean): Promise<boolean> {
	const realRoot = await realPathOrUndefined(root);
	const realCandidate = await realPathForWrite(candidate);
	if (!realRoot || !realCandidate) {
		return false;
	}
	return !isPathInside(realRoot, realCandidate, caseInsensitive);
}
