/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new ChatViewProvider(context.extensionUri);
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider('quasi.chat.view', provider, {
			webviewOptions: { retainContextWhenHidden: false }
		}),
		vscode.commands.registerCommand('quasi.chat.open', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.quasiChat');
		}),
		vscode.commands.registerCommand('quasi.chat.newChat', () => provider.newChat()),
		vscode.workspace.onDidGrantWorkspaceTrust(() => provider.notifyWorkspaceChanged()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.notifyWorkspaceChanged())
	);
}
