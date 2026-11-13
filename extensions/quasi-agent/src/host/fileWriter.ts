/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

function wasOpen(uri: vscode.Uri): boolean {
	return vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString());
}

function commonPrefixLength(before: string, after: string): number {
	const limit = Math.min(before.length, after.length);
	let index = 0;
	while (index < limit && before.charCodeAt(index) === after.charCodeAt(index)) {
		index++;
	}
	return index;
}

function commonSuffixLength(before: string, after: string, prefix: number): number {
	const limit = Math.min(before.length, after.length) - prefix;
	let length = 0;
	while (length < limit
		&& before.charCodeAt(before.length - 1 - length) === after.charCodeAt(after.length - 1 - length)) {
		length++;
	}
	return length;
}

/**
 * Applies edits through `WorkspaceEdit` so open (including dirty) buffers are
 * respected and editor undo works. Documents that were not open are saved;
 * already-open documents are left dirty for the user to review.
 */
export class FileWriter {

	async applyChange(absolute: string, before: string, after: string): Promise<boolean> {
		const uri = vscode.Uri.file(absolute);
		const openBefore = wasOpen(uri);
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(uri);
		} catch {
			return false;
		}
		if (document.getText() !== before) {
			return false;
		}
		const prefix = commonPrefixLength(before, after);
		const suffix = commonSuffixLength(before, after, prefix);
		const replacement = after.slice(prefix, after.length - suffix);
		const range = new vscode.Range(document.positionAt(prefix), document.positionAt(before.length - suffix));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, replacement);
		if (!await vscode.workspace.applyEdit(edit)) {
			return false;
		}
		if (!openBefore) {
			await this.saveQuietly(document);
		}
		return true;
	}

	async writeWhole(absolute: string, text: string): Promise<boolean> {
		const uri = vscode.Uri.file(absolute);
		const openBefore = wasOpen(uri);
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(uri);
		} catch {
			return this.create(absolute, text);
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
		if (!await vscode.workspace.applyEdit(edit)) {
			return false;
		}
		if (!openBefore) {
			await this.saveQuietly(document);
		}
		return true;
	}

	async create(absolute: string, text: string): Promise<boolean> {
		const uri = vscode.Uri.file(absolute);
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absolute)));
		} catch {
			// the parent may already exist
		}
		const edit = new vscode.WorkspaceEdit();
		edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
		edit.insert(uri, new vscode.Position(0, 0), text);
		if (!await vscode.workspace.applyEdit(edit)) {
			return false;
		}
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			await this.saveQuietly(document);
		} catch {
			return false;
		}
		return true;
	}

	async remove(absolute: string): Promise<boolean> {
		const edit = new vscode.WorkspaceEdit();
		edit.deleteFile(vscode.Uri.file(absolute), { ignoreIfNotExists: true, recursive: false });
		return vscode.workspace.applyEdit(edit);
	}

	private async saveQuietly(document: vscode.TextDocument): Promise<void> {
		try {
			await document.save();
		} catch {
			// best effort; the edit is still applied to the buffer
		}
	}
}

/** Current text of a file, including unsaved buffer content. Undefined if missing. */
export async function readCurrentText(absolute: string): Promise<string | undefined> {
	const uri = vscode.Uri.file(absolute);
	const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		return document.getText();
	} catch {
		return undefined;
	}
}
