/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const MAX_ENTRIES = 20;
const MAX_TOTAL_BYTES = 8_000_000;

interface DiffEntry {
	readonly before: string;
	readonly after: string;
	readonly title: string;
	readonly bytes: number;
}

/**
 * In-memory, read-only text documents backing `vscode.diff` for agent changes.
 * The `quasi-diff` scheme is not writable, and storage is capped so a long
 * session does not grow without bound.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {

	static readonly scheme = 'quasi-diff';

	private readonly entries = new Map<string, DiffEntry>();
	private totalBytes = 0;
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly registration: vscode.Disposable;

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, this);
	}

	remember(id: string, before: string, after: string, title: string): boolean {
		const bytes = before.length + after.length;
		if (bytes > MAX_TOTAL_BYTES) {
			return false;
		}
		this.forget(id);
		while ((this.entries.size >= MAX_ENTRIES || this.totalBytes + bytes > MAX_TOTAL_BYTES) && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.forget(oldest);
		}
		this.entries.set(id, { before, after, title, bytes });
		this.totalBytes += bytes;
		return true;
	}

	forget(id: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			this.entries.delete(id);
			this.totalBytes -= entry.bytes;
		}
	}

	async show(id: string): Promise<boolean> {
		const entry = this.entries.get(id);
		if (!entry) {
			return false;
		}
		const before = this.uriFor(id, 'before');
		const after = this.uriFor(id, 'after');
		await vscode.commands.executeCommand('vscode.diff', before, after, `${entry.title} (agent change)`);
		return true;
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const id = decodeURIComponent(uri.query);
		const side = uri.path.replace(/^\/+/, '');
		const entry = this.entries.get(id);
		if (!entry) {
			return '';
		}
		return side === 'before' ? entry.before : entry.after;
	}

	private uriFor(id: string, side: 'before' | 'after'): vscode.Uri {
		return vscode.Uri.from({ scheme: DiffContentProvider.scheme, path: `/${side}`, query: encodeURIComponent(id) });
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	dispose(): void {
		this.registration.dispose();
		this.changeEmitter.dispose();
	}
}
