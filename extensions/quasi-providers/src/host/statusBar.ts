/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type ConnectionState = 'online' | 'offline' | 'unknown' | 'rejected';

export interface StatusBarInput {
	readonly hasProviders: boolean;
	readonly providerName?: string;
	readonly model?: string;
}

/** Status bar item showing the active provider/model and connection state. */
export class StatusBar implements vscode.Disposable {

	private readonly item: vscode.StatusBarItem;
	private input: StatusBarInput = { hasProviders: false };
	private state: ConnectionState = 'unknown';

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.render();
	}

	update(input: StatusBarInput): void {
		this.input = input;
		this.render();
	}

	setState(state: ConnectionState): void {
		this.state = state;
		this.render();
	}

	dispose(): void {
		this.item.dispose();
	}

	private render(): void {
		if (!this.input.hasProviders) {
			this.item.text = '$(add) Quasi: no model';
			this.item.tooltip = 'No model provider configured. Click to add one.';
			this.item.command = 'quasi.provider.menu';
			this.item.show();
			return;
		}

		if (!this.input.providerName) {
			this.item.text = '$(add) Quasi: no model';
			this.item.tooltip = 'No active model selected. Click to switch model or add a provider.';
			this.item.command = 'quasi.provider.menu';
			this.item.show();
			return;
		}

		const icon = this.state === 'online' ? '$(check)'
			: this.state === 'offline' ? '$(debug-disconnect)'
				: this.state === 'rejected' ? '$(error)'
					: '$(question)';
		const label = this.input.model ? `${this.input.providerName} · ${this.input.model}` : this.input.providerName;
		this.item.text = `${icon} ${label}`;
		const stateText = this.state === 'rejected' ? 'API key rejected' : this.state;
		this.item.tooltip = `Quasi model: ${label}\nConnection: ${stateText}\nClick for actions.`;
		this.item.command = 'quasi.provider.menu';
		this.item.show();
	}
}
