/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { resolveSandboxPath } from '../core/tools/pathPolicy';
import { ToolDef, ToolResult } from '../core/tools/registry';
import { isSensitivePath } from '../core/tools/secretFiles';
import { isRealPathOutside } from './symlinks';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINES = 1000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 200 * 1024;
const SEARCH_TIME_BUDGET_MS = 3000;
const MAX_SEARCH_LINE_CHARS = 300;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function errorResult(message: string): ToolResult {
	return { content: message, summary: message, isError: true };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function isBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, 8000);
	for (let index = 0; index < limit; index++) {
		if (bytes[index] === 0) {
			return true;
		}
	}
	return false;
}

function absoluteFor(rootPath: string, candidate: string): string {
	return path.isAbsolute(candidate) ? path.normalize(candidate) : path.normalize(path.join(rootPath, candidate));
}

function relativeFromRoot(rootPath: string, uri: vscode.Uri): string | undefined {
	const relative = path.relative(rootPath, uri.fsPath);
	if (relative.length === 0) {
		return '.';
	}
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(path.sep).join('/');
}

export function createReadTools(rootUri: vscode.Uri): ToolDef[] {
	const rootPath = rootUri.fsPath;

	const readFile: ToolDef = {
		name: 'read_file',
		description: 'Read a UTF-8 text file from the workspace, optionally a 1-based inclusive line range. Binary files are refused.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				startLine: { type: 'integer' },
				endLine: { type: 'integer' }
			},
			required: ['path'],
			additionalProperties: false
		},
		requires: ['fs.read'],
		risk: 'read',
		needsApproval: async args => {
			const candidate = typeof args.path === 'string' ? args.path : '';
			const resolution = resolveSandboxPath(rootPath, candidate, CASE_INSENSITIVE);
			const absolute = absoluteFor(rootPath, candidate);
			if (resolution.outsideWorkspace || await isRealPathOutside(rootPath, absolute, CASE_INSENSITIVE)) {
				return { toolName: 'read_file', reason: 'outside-workspace', detail: absolute };
			}
			if (resolution.ok && isSensitivePath(resolution.relativePath ?? '')) {
				return { toolName: 'read_file', reason: 'sensitive-file', detail: resolution.relativePath ?? candidate };
			}
			return undefined;
		},
		run: async args => {
			const candidate = typeof args.path === 'string' ? args.path : '';
			const resolution = resolveSandboxPath(rootPath, candidate, CASE_INSENSITIVE);
			const absolute = absoluteFor(rootPath, candidate);
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
				if (stat.type & vscode.FileType.Directory) {
					return errorResult('Path is a directory.');
				}
				if (stat.size > MAX_READ_BYTES) {
					return errorResult(`File is too large to read (${stat.size} bytes).`);
				}
				const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolute));
				if (isBinary(bytes)) {
					return errorResult('File appears to be binary and was not read.');
				}
				const text = new TextDecoder('utf-8').decode(bytes);
				const lines = text.split(/\r\n|\n|\r/);
				const total = lines.length;
				const requestedStart = typeof args.startLine === 'number' ? args.startLine : 1;
				const requestedEnd = typeof args.endLine === 'number' ? args.endLine : total;
				const start = clamp(requestedStart, 1, Math.max(1, total));
				const end = clamp(requestedEnd, start, Math.max(start, total));
				const sliceEnd = Math.min(end, start - 1 + MAX_READ_LINES);
				const selected = lines.slice(start - 1, sliceEnd);
				const label = resolution.ok ? (resolution.relativePath || '.') : '(outside workspace)';
				let content = `${label} (lines ${start}-${sliceEnd} of ${total})\n${selected.join('\n')}`;
				if (sliceEnd < end) {
					content += '\n[truncated to 1000 lines]';
				}
				return { content, summary: `read ${label} (${selected.length} line${selected.length === 1 ? '' : 's'})` };
			} catch {
				return errorResult('Could not read the file.');
			}
		}
	};

	const listDir: ToolDef = {
		name: 'list_dir',
		description: 'List files and folders in a workspace directory. Skips .git and node_modules.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string' } },
			additionalProperties: false
		},
		requires: ['fs.read'],
		risk: 'read',
		needsApproval: async args => {
			const candidate = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
			const resolution = resolveSandboxPath(rootPath, candidate, CASE_INSENSITIVE);
			const absolute = absoluteFor(rootPath, candidate);
			if (resolution.outsideWorkspace || await isRealPathOutside(rootPath, absolute, CASE_INSENSITIVE)) {
				return { toolName: 'list_dir', reason: 'outside-workspace', detail: absolute };
			}
			return undefined;
		},
		run: async args => {
			const candidate = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
			const resolution = resolveSandboxPath(rootPath, candidate, CASE_INSENSITIVE);
			const absolute = absoluteFor(rootPath, candidate);
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absolute));
				const sorted = entries
					.filter(([name]) => !SKIP_DIRS.has(name))
					.sort(([left], [right]) => left.localeCompare(right));
				const shown = sorted.slice(0, MAX_LIST_ENTRIES);
				const label = resolution.ok ? (resolution.relativePath || '.') : '(outside workspace)';
				const lines = shown.map(([name, type]) => type & vscode.FileType.Directory ? `${name}/` : name);
				let content = `${label}:\n${lines.join('\n')}`;
				if (sorted.length > MAX_LIST_ENTRIES) {
					content += '\n[truncated]';
				}
				return { content, summary: `listed ${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}` };
			} catch {
				return errorResult('Could not list the directory.');
			}
		}
	};

	const search: ToolDef = {
		name: 'search',
		description: 'Search workspace text files for a literal, case-insensitive string. Returns path:line: text. Skips .git, node_modules, binary, and sensitive files.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				glob: { type: 'string' }
			},
			required: ['query'],
			additionalProperties: false
		},
		requires: ['fs.read'],
		risk: 'read',
		run: async (args, signal) => {
			const query = typeof args.query === 'string' ? args.query.trim() : '';
			if (query.length === 0) {
				return errorResult('Search query is empty.');
			}
			const glob = typeof args.glob === 'string' && args.glob.length > 0 ? args.glob : '**/*';
			let files: vscode.Uri[];
			try {
				files = await vscode.workspace.findFiles(glob, '**/{.git,node_modules}/**', MAX_SEARCH_FILES);
			} catch {
				return errorResult('Could not enumerate files.');
			}

			const started = Date.now();
			const needle = query.toLowerCase();
			const matches: string[] = [];
			let scannedFiles = 0;
			let scannedBytes = 0;
			let incomplete = false;

			for (const file of files) {
				if (signal.aborted) {
					incomplete = true;
					break;
				}
				if (Date.now() - started > SEARCH_TIME_BUDGET_MS || scannedBytes > MAX_SEARCH_BYTES) {
					incomplete = true;
					break;
				}
				const relative = relativeFromRoot(rootPath, file);
				if (relative === undefined) {
					incomplete = true;
					continue;
				}
				if (isSensitivePath(relative)) {
					continue;
				}
				try {
					const stat = await vscode.workspace.fs.stat(file);
					if (stat.type & vscode.FileType.Directory || stat.size > MAX_SEARCH_FILE_BYTES) {
						continue;
					}
					const bytes = await vscode.workspace.fs.readFile(file);
					scannedFiles++;
					scannedBytes += bytes.length;
					if (isBinary(bytes)) {
						continue;
					}
					const lines = new TextDecoder('utf-8').decode(bytes).split(/\r\n|\n|\r/);
					for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
						const line = lines[lineIndex];
						if (!line.toLowerCase().includes(needle)) {
							continue;
						}
						const snippet = line.length > MAX_SEARCH_LINE_CHARS ? `${line.slice(0, MAX_SEARCH_LINE_CHARS)}…` : line;
						matches.push(`${relative}:${lineIndex + 1}: ${snippet}`);
						if (matches.length >= MAX_SEARCH_MATCHES) {
							incomplete = true;
							break;
						}
					}
				} catch {
					continue;
				}
				if (matches.length >= MAX_SEARCH_MATCHES) {
					break;
				}
			}

			const header = `${matches.length} match(es) in ${scannedFiles} file(s)${incomplete ? ' (incomplete: limits reached)' : ''}`;
			const content = matches.length === 0 ? header : `${header}\n${matches.join('\n')}`;
			return { content, summary: `${matches.length} match(es)${incomplete ? ' (incomplete)' : ''}` };
		}
	};

	return [listDir, readFile, search];
}
