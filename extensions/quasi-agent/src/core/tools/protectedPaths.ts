/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isSensitivePath } from './secretFiles';

/** Directories whose contents can execute code or change tooling/agent behavior. */
const PROTECTED_DIRECTORIES = new Set([
	'.git',
	'.vscode',
	'.github',
	'.devcontainer',
	'.husky',
	'.quasi'
]);

/** Exact (lowercased) basenames that always need approval before a write/delete. */
const PROTECTED_BASENAMES = new Set([
	'.envrc',
	'agents.md',
	'package.json',
	'pyproject.toml',
	'setup.py',
	'cargo.toml',
	'build.rs',
	'pom.xml',
	'gemfile',
	'go.mod',
	'composer.json',
	'makefile',
	'gnumakefile',
	'dockerfile',
	'.gitlab-ci.yml',
	'jenkinsfile',
	'rakefile',
	'justfile',
	'taskfile.yml',
	'lefthook.yml',
	'.pre-commit-config.yaml',
	'.npmrc',
	'.yarnrc'
]);

const PROTECTED_EXTENSIONS = [
	'.sh',
	'.ps1',
	'.bat',
	'.cmd',
	'.mk',
	'.service',
	'.desktop',
	'.code-workspace',
	'.csproj'
];

/**
 * Normalize a relative path for protected matching:
 * - forward slashes and lowercase (case-insensitive filesystems)
 * - strip NTFS alternate stream suffixes (`::$DATA`, `:stream`)
 * - strip trailing dots and spaces (Windows trims these)
 */
export function normalizeProtectedPath(relativePath: string): string {
	return relativePath
		.replace(/\\/g, '/')
		.split('/')
		.map(segment => segment.replace(/:.*$/, '').replace(/[ .]+$/g, '').toLowerCase())
		.filter(segment => segment.length > 0)
		.join('/');
}

/**
 * Whether writing to (or deleting) this workspace-relative path always requires
 * approval, even inside the workspace, because the file can execute code or
 * change tooling/agent behavior without going through the terminal gate.
 */
export function requiresWriteApproval(relativePath: string): boolean {
	const normalized = normalizeProtectedPath(relativePath);
	if (normalized.length === 0) {
		return false;
	}
	const segments = normalized.split('/');
	if (segments.some(segment => PROTECTED_DIRECTORIES.has(segment))) {
		return true;
	}
	const basename = segments[segments.length - 1];
	if (PROTECTED_BASENAMES.has(basename)) {
		return true;
	}
	if (basename.startsWith('requirements') && basename.endsWith('.txt')) {
		return true;
	}
	if (basename.startsWith('build.gradle')) {
		return true;
	}
	if (basename.startsWith('docker-compose') && (basename.endsWith('.yml') || basename.endsWith('.yaml'))) {
		return true;
	}
	if (basename.startsWith('.yarnrc')) {
		return true;
	}
	for (const extension of PROTECTED_EXTENSIONS) {
		if (basename.endsWith(extension)) {
			return true;
		}
	}
	return isSensitivePath(normalized);
}
