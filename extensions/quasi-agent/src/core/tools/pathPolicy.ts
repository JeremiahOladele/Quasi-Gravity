/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface PathResolution {
	readonly ok: boolean;
	/** Path relative to the sandbox root, using forward slashes. */
	readonly relativePath?: string;
	readonly outsideWorkspace: boolean;
	readonly reason?: string;
}

function toPosix(value: string): string {
	return value.replace(/\\/g, '/');
}

/** POSIX absolute, Windows drive absolute, or UNC (`//server/share`). */
export function isAbsolutePath(value: string): boolean {
	const path = toPosix(value);
	return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || /^[A-Za-z]:$/.test(path);
}

function normalizeSegments(value: string): string[] {
	const segments: string[] = [];
	for (const part of value.split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			if (segments.length > 0) {
				segments.pop();
			}
		} else {
			segments.push(part);
		}
	}
	return segments;
}

function normalizeAbsolute(value: string): string {
	if (value.startsWith('//')) {
		return '//' + normalizeSegments(value.slice(2)).join('/');
	}
	const drive = /^([A-Za-z]:)/.exec(value);
	if (drive) {
		return `${drive[1]}/${normalizeSegments(value.slice(drive[1].length).replace(/^\//, '')).join('/')}`;
	}
	return '/' + normalizeSegments(value.replace(/^\//, '')).join('/');
}

function sameOrUnder(path: string, root: string, caseInsensitive: boolean): boolean {
	const p = caseInsensitive ? path.toLowerCase() : path;
	const r = caseInsensitive ? root.toLowerCase() : root;
	return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * Resolve a tool path against an explicit sandbox root.
 * - Relative paths that escape via `..` are rejected as outside.
 * - Absolute paths inside the root are converted to a relative path.
 * - Absolute paths outside the root are reported as outside (caller may ask
 *   for approval).
 * - Returned paths are relative and use forward slashes.
 */
export function resolveSandboxPath(root: string, candidate: string, caseInsensitive = false): PathResolution {
	const trimmed = candidate.trim();
	if (trimmed.length === 0) {
		return { ok: false, outsideWorkspace: false, reason: 'empty path' };
	}

	const rootPosix = toPosix(root).replace(/\/+$/, '');
	const rootSegments = normalizeSegments(rootPosix);
	const rootKey = normalizeAbsolute(rootPosix);
	const candidatePosix = toPosix(trimmed);

	if (isAbsolutePath(candidatePosix)) {
		const normalized = normalizeAbsolute(candidatePosix);
		if (!sameOrUnder(normalized, rootKey, caseInsensitive)) {
			return { ok: false, outsideWorkspace: true, reason: 'absolute path outside the workspace' };
		}
		const relative = normalized.slice(rootKey.length).replace(/^\/+/, '');
		return { ok: true, relativePath: normalizeSegments(relative).join('/'), outsideWorkspace: false };
	}

	const combined = [...rootSegments, ...candidatePosix.split('/')];
	const resolved: string[] = [];
	for (const part of combined) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			if (resolved.length <= rootSegments.length) {
				return { ok: false, outsideWorkspace: true, reason: 'path escapes the workspace' };
			}
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}

	return {
		ok: true,
		relativePath: resolved.slice(rootSegments.length).join('/'),
		outsideWorkspace: false
	};
}
