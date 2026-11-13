/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { SafetyDefaultsLike } from '../core/providerApi';
import { BULK_CHANGE_LIMIT, BulkChangeGuard } from '../core/tools/bulkGuard';
import { computeDiff, computeLineStats } from '../core/tools/diff';
import { detectEol, convertEol, newFileText, planEdits } from '../core/tools/editPlan';
import { ApprovalPrompt, ApprovalReasonCode, JsonSchema, ToolDef, ToolResult } from '../core/tools/registry';
import { resolveSandboxPath } from '../core/tools/pathPolicy';
import { requiresWriteApproval } from '../core/tools/protectedPaths';
import { UndoBook, UndoKind } from '../core/tools/undo';
import { isWriteTargetOutside } from './symlinks';
import { FileWriter } from './fileWriter';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CHARS = 19_000;

export interface AppliedChange {
	readonly id: string;
	readonly path: string;
	readonly summary: string;
	readonly diff: string;
	readonly diffTruncated: boolean;
	readonly canRevert: boolean;
	readonly before: string;
	readonly after: string;
}

export interface EditToolsOptions {
	readonly rootUri: vscode.Uri;
	readonly undo: UndoBook;
	readonly guard: BulkChangeGuard;
	readonly writer: FileWriter;
	readonly broker: { requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> };
	readonly getDefaults: () => SafetyDefaultsLike | undefined;
	readonly onApplied: (change: AppliedChange) => void;
}

interface Target {
	readonly absolute: string;
	readonly display: string;
	readonly outside: boolean;
	readonly escape: boolean;
}

interface ExistingFile {
	readonly exists: boolean;
	readonly directory: boolean;
	readonly text: string;
	readonly error?: string;
}

interface EditInput {
	readonly oldText: string;
	readonly newText: string;
}

function errorResult(message: string): ToolResult {
	return { content: message, summary: message, isError: true };
}

function isNotFound(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	return code === 'FileNotFound' || code === 'EntryNotFound';
}

function absoluteFor(rootPath: string, candidate: string): string {
	return path.isAbsolute(candidate) ? path.normalize(candidate) : path.normalize(path.join(rootPath, candidate));
}

async function resolveTarget(rootPath: string, candidate: string): Promise<Target> {
	const trimmed = candidate.trim();
	const absolute = absoluteFor(rootPath, trimmed);
	if (trimmed.length === 0) {
		return { absolute, display: '', outside: false, escape: true };
	}
	const resolution = resolveSandboxPath(rootPath, trimmed, CASE_INSENSITIVE);
	if (resolution.outsideWorkspace && resolution.reason === 'path escapes the workspace') {
		return { absolute, display: trimmed, outside: true, escape: true };
	}
	const symlinkOutside = await isWriteTargetOutside(rootPath, absolute, CASE_INSENSITIVE);
	const outside = resolution.outsideWorkspace || symlinkOutside;
	return {
		absolute,
		display: outside ? absolute : (resolution.relativePath || trimmed),
		outside,
		escape: false
	};
}

async function readExisting(absolute: string): Promise<ExistingFile> {
	const uri = vscode.Uri.file(absolute);
	let stat: vscode.FileStat;
	try {
		stat = await vscode.workspace.fs.stat(uri);
	} catch (error) {
		if (isNotFound(error)) {
			return { exists: false, directory: false, text: '' };
		}
		return { exists: false, directory: false, text: '', error: 'Could not access the path.' };
	}
	if (stat.type & vscode.FileType.Directory) {
		return { exists: true, directory: true, text: '' };
	}
	if (stat.size > MAX_EDIT_BYTES) {
		return { exists: true, directory: false, text: '', error: 'File is too large to edit (limit 2 MB).' };
	}
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return { exists: true, directory: false, text: '', error: 'File is not valid UTF-8 and was not edited.' };
	}
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		return { exists: true, directory: false, text: document.getText() };
	} catch {
		return { exists: true, directory: false, text: '', error: 'Could not open the file for editing.' };
	}
}

function diffPreview(before: string, after: string): { text: string; truncated: boolean } {
	const diff = computeDiff(before, after);
	if (!diff.statsExact) {
		return { text: '', truncated: true };
	}
	let text = diff.lines.join('\n');
	let truncated = diff.outputTruncated;
	if (text.length > MAX_DIFF_CHARS) {
		text = text.slice(0, MAX_DIFF_CHARS);
		truncated = true;
	}
	if (truncated) {
		text += '\n[diff truncated]';
	}
	return { text, truncated };
}

function parseEdits(raw: unknown): EditInput[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const edits: EditInput[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) {
			return undefined;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.oldText !== 'string' || typeof record.newText !== 'string') {
			return undefined;
		}
		edits.push({ oldText: record.oldText, newText: record.newText });
	}
	return edits;
}

function isDestructive(before: string, after: string): boolean {
	if (after.length < before.length * 0.5) {
		return true;
	}
	const stats = computeLineStats(before, after);
	return stats.exact && stats.removed > 100;
}

function configuredEol(): '\r\n' | '\n' | 'auto' | undefined {
	const inspected = vscode.workspace.getConfiguration('files').inspect<'auto' | '\n' | '\r\n'>('eol');
	return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue ?? undefined;
}

const editParameters: JsonSchema = {
	type: 'object',
	properties: {
		path: { type: 'string' },
		edits: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					oldText: { type: 'string' },
					newText: { type: 'string' }
				},
				required: ['oldText', 'newText'],
				additionalProperties: false
			}
		}
	},
	required: ['path', 'edits'],
	additionalProperties: false
};

const writeParameters: JsonSchema = {
	type: 'object',
	properties: {
		path: { type: 'string' },
		content: { type: 'string' }
	},
	required: ['path', 'content'],
	additionalProperties: false
};

const deleteParameters: JsonSchema = {
	type: 'object',
	properties: { path: { type: 'string' } },
	required: ['path'],
	additionalProperties: false
};

export function createEditTools(options: EditToolsOptions): ToolDef[] {
	const rootPath = options.rootUri.fsPath;
	let changeCounter = 0;
	let pendingApproval = false;
	let pendingApprovalReady = false;

	const beginApproval = (): void => {
		pendingApproval = false;
		pendingApprovalReady = true;
	};
	const finishApproval = (result: ApprovalPrompt | undefined): ApprovalPrompt | undefined => {
		pendingApproval = !!result;
		return result;
	};
	const consumeApproval = (): boolean | undefined => {
		if (!pendingApprovalReady) {
			return undefined;
		}
		const value = pendingApproval;
		pendingApprovalReady = false;
		return value;
	};

	const askOutside = (): boolean => options.getDefaults()?.permissions.askBeforeWriteOutsideWorkspace ?? true;

	const prompt = (
		toolName: string,
		target: Target,
		candidate: string,
		before: string,
		after: string,
		kind: 'write' | 'delete' | 'destructive'
	): ApprovalPrompt | undefined => {
		const protectedPath = requiresWriteApproval(target.outside ? candidate : target.display);
		let reason: ApprovalReasonCode | undefined;
		if (kind === 'delete') {
			reason = 'delete';
		} else if (protectedPath) {
			reason = 'protected-path';
		} else if (target.outside) {
			reason = askOutside() ? 'outside-workspace' : undefined;
		} else if (kind === 'destructive') {
			reason = 'destructive-write';
		}
		if (!reason) {
			return undefined;
		}
		const preview = diffPreview(before, after);
		return { toolName, reason, detail: target.display, ...(preview.text.length > 0 ? { diff: preview.text } : {}) };
	};

	const maybeAskBulk = async (toolName: string, signal: AbortSignal): Promise<boolean> => {
		if (options.guard.register() !== 'ask') {
			return true;
		}
		const approved = await options.broker.requestApproval({
			toolName,
			reason: 'bulk-change',
			detail: `This message has already made more than ${BULK_CHANGE_LIMIT} automatic file changes. Allow more?`
		}, signal);
		if (!approved) {
			return false;
		}
		options.guard.approve();
		return true;
	};

	const emitChange = (target: Target, kind: UndoKind, before: string, after: string): void => {
		const record = options.undo.record({
			path: target.absolute,
			kind,
			before: kind === 'created' ? undefined : before,
			after: kind === 'deleted' ? undefined : after
		});
		const preview = diffPreview(before, after);
		const summary = kind === 'created' ? `Created ${target.display}` : kind === 'deleted' ? `Deleted ${target.display}` : `Edited ${target.display}`;
		options.onApplied({
			id: record?.id ?? `change-${++changeCounter}`,
			path: target.display,
			summary,
			diff: preview.text,
			diffTruncated: preview.truncated,
			canRevert: !!record,
			before,
			after
		});
	};

	const editFile: ToolDef = {
		name: 'edit_file',
		description: 'Edit a workspace text file with exact search-and-replace edits. Prefer this over write_file. oldText must match exactly once in the file (include surrounding context); all edits apply or none do. To create a new file use write_file.',
		parameters: editParameters,
		requires: ['fs.write'],
		risk: 'write',
		needsApproval: async args => {
			beginApproval();
			const candidate = typeof args.path === 'string' ? args.path : '';
			const edits = parseEdits(args.edits);
			if (!edits || edits.length === 0) {
				return undefined;
			}
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return undefined;
			}
			const current = await readExisting(target.absolute);
			if (!current.exists || current.directory || current.error) {
				return undefined;
			}
			const plan = planEdits(current.text, edits);
			if (!plan.ok || plan.text === current.text) {
				return undefined;
			}
			return finishApproval(prompt('edit_file', target, candidate, current.text, plan.text, 'write'));
		},
		run: async (args, signal) => {
			const candidate = typeof args.path === 'string' ? args.path : '';
			const edits = parseEdits(args.edits);
			if (!edits || edits.length === 0) {
				return errorResult('No edits were provided.');
			}
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return errorResult('Path escapes the workspace.');
			}
			const current = await readExisting(target.absolute);
			if (!current.exists) {
				return errorResult('File does not exist. Use write_file to create it.');
			}
			if (current.directory) {
				return errorResult('Path is a directory.');
			}
			if (current.error) {
				return errorResult(current.error);
			}
			const plan = planEdits(current.text, edits);
			if (!plan.ok) {
				return errorResult(plan.error);
			}
			if (plan.text === current.text) {
				return { content: 'No change.', summary: `No change to ${target.display}` };
			}
			const approval = prompt('edit_file', target, candidate, current.text, plan.text, 'write');
			const wasApproved = consumeApproval();
			if (wasApproved === undefined || wasApproved !== !!approval) {
				return errorResult('The file changed while approval was pending. Try again.');
			}
			if (!wasApproved && !await maybeAskBulk('edit_file', signal)) {
				return errorResult('Denied by user (bulk change).');
			}
			const applied = await options.writer.applyChange(target.absolute, current.text, plan.text);
			if (!applied) {
				return errorResult('Could not apply the edit. The file may have changed.');
			}
			emitChange(target, 'modified', current.text, plan.text);
			const summary = `Edited ${target.display}: ${plan.replacements} replacement(s), +${plan.addedLines}/-${plan.removedLines} line(s).`;
			return { content: summary, summary: `edited ${target.display} (+${plan.addedLines}/-${plan.removedLines})` };
		}
	};

	const writeFile: ToolDef = {
		name: 'write_file',
		description: 'Create a file, or replace an existing file entirely. Prefer edit_file for changes to existing files; this overwrites the whole file. Preserves an existing file\'s line endings.',
		parameters: writeParameters,
		requires: ['fs.write'],
		risk: 'write',
		needsApproval: async args => {
			beginApproval();
			const candidate = typeof args.path === 'string' ? args.path : '';
			const content = typeof args.content === 'string' ? args.content : '';
			if (content.length > MAX_EDIT_BYTES) {
				return undefined;
			}
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return undefined;
			}
			const current = await readExisting(target.absolute);
			if (current.directory || current.error) {
				return undefined;
			}
			const after = current.exists ? convertEol(content, detectEol(current.text)) : newFileText(content, { configuredEol: configuredEol() });
			if (current.exists && after === current.text) {
				return undefined;
			}
			const destructive = current.exists && isDestructive(current.text, after);
			return finishApproval(prompt('write_file', target, candidate, current.exists ? current.text : '', after, destructive ? 'destructive' : 'write'));
		},
		run: async (args, signal) => {
			const candidate = typeof args.path === 'string' ? args.path : '';
			const content = typeof args.content === 'string' ? args.content : '';
			if (content.length > MAX_EDIT_BYTES) {
				return errorResult('Content is too large to write (limit 2 MB).');
			}
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return errorResult('Path escapes the workspace.');
			}
			const current = await readExisting(target.absolute);
			if (current.directory) {
				return errorResult('Path is a directory.');
			}
			if (current.error) {
				return errorResult(current.error);
			}
			const after = current.exists ? convertEol(content, detectEol(current.text)) : newFileText(content, { configuredEol: configuredEol() });
			if (current.exists && after === current.text) {
				return { content: 'No change.', summary: `No change to ${target.display}` };
			}
			const destructive = current.exists && isDestructive(current.text, after);
			const approval = prompt('write_file', target, candidate, current.exists ? current.text : '', after, destructive ? 'destructive' : 'write');
			const wasApproved = consumeApproval();
			if (wasApproved === undefined || wasApproved !== !!approval) {
				return errorResult('The file changed while approval was pending. Try again.');
			}
			if (!wasApproved && !await maybeAskBulk('write_file', signal)) {
				return errorResult('Denied by user (bulk change).');
			}
			const applied = current.exists
				? await options.writer.applyChange(target.absolute, current.text, after)
				: await options.writer.create(target.absolute, after);
			if (!applied) {
				return errorResult('Could not write the file. It may have changed.');
			}
			const kind: UndoKind = current.exists ? 'modified' : 'created';
			emitChange(target, kind, current.exists ? current.text : '', after);
			if (!current.exists) {
				return { content: `Created ${target.display}.`, summary: `created ${target.display}` };
			}
			const stats = computeLineStats(current.text, after);
			return { content: `Wrote ${target.display}: +${stats.added}/-${stats.removed} line(s).`, summary: `wrote ${target.display} (+${stats.added}/-${stats.removed})` };
		}
	};

	const deleteFile: ToolDef = {
		name: 'delete_file',
		description: 'Delete a file from the workspace. This always asks for approval and can be reverted in the chat until the session ends.',
		parameters: deleteParameters,
		requires: ['fs.write'],
		risk: 'write',
		needsApproval: async args => {
			beginApproval();
			const candidate = typeof args.path === 'string' ? args.path : '';
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return undefined;
			}
			const current = await readExisting(target.absolute);
			if (!current.exists || current.directory || current.error) {
				return undefined;
			}
			return finishApproval(prompt('delete_file', target, candidate, current.text, '', 'delete'));
		},
		run: async args => {
			const candidate = typeof args.path === 'string' ? args.path : '';
			const target = await resolveTarget(rootPath, candidate);
			if (target.escape) {
				return errorResult('Path escapes the workspace.');
			}
			const current = await readExisting(target.absolute);
			if (!current.exists) {
				return errorResult('File does not exist.');
			}
			if (current.directory) {
				return errorResult('Path is a directory; only files can be deleted.');
			}
			if (current.error) {
				return errorResult(current.error);
			}
			const approval = prompt('delete_file', target, candidate, current.text, '', 'delete');
			const wasApproved = consumeApproval();
			if (wasApproved === undefined || wasApproved !== !!approval) {
				return errorResult('The file changed while approval was pending. Try again.');
			}
			if (!await options.writer.remove(target.absolute)) {
				return errorResult('Could not delete the file.');
			}
			emitChange(target, 'deleted', current.text, '');
			return { content: `Deleted ${target.display}.`, summary: `deleted ${target.display}` };
		}
	};

	return [editFile, writeFile, deleteFile];
}
