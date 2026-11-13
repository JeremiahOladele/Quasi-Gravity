/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Capability } from '../core/tools/registry';

export interface WorkspaceContext {
	readonly trusted: boolean;
	readonly rootUri?: vscode.Uri;
	readonly rootName?: string;
	readonly rootPath?: string;
	readonly multiRoot: boolean;
	readonly capabilities: ReadonlySet<Capability>;
	readonly disabledReason?: string;
}

/**
 * Sandbox root is the FIRST workspace folder, explicitly. Multi-root is reported
 * so the UI can warn that only the first folder is available to tools.
 */
export function resolveWorkspaceContext(): WorkspaceContext {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const trusted = vscode.workspace.isTrusted;
	const multiRoot = folders.length > 1;
	if (folders.length === 0) {
		return { trusted, multiRoot: false, capabilities: new Set(), disabledReason: 'no folder is open' };
	}
	const root = folders[0];
	if (!trusted) {
		return {
			trusted,
			rootUri: root.uri,
			rootName: root.name,
			rootPath: root.uri.fsPath,
			multiRoot,
			capabilities: new Set(),
			disabledReason: 'the workspace is not trusted'
		};
	}
	return {
		trusted,
		rootUri: root.uri,
		rootName: root.name,
		rootPath: root.uri.fsPath,
		multiRoot,
		capabilities: new Set<Capability>(['fs.read'])
	};
}

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function osName(): string {
	return process.platform;
}

/** Best-effort default shell name for the system prompt. */
export function detectShell(): string {
	if (process.platform === 'win32') {
		const isPowerShell = !!process.env.PSModulePath && !process.env.SHELL;
		return isPowerShell ? 'PowerShell' : (process.env.ComSpec ?? 'cmd.exe');
	}
	const shell = process.env.SHELL;
	if (shell) {
		return shell.split('/').pop() ?? shell;
	}
	return process.platform === 'darwin' ? 'zsh' : 'bash';
}
