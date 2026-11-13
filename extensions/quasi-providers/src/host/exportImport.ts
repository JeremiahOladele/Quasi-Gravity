/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QuasiSettingsV1, SETTINGS_VERSION, scanForSecrets, serializeQuasiSettings, validateProviderBaseUrl } from '../core/settingsSchema';
import { readActiveModel, readActiveProviderId, readDefaults, readProviders } from './settings';

/** File access abstraction so a web version can supply its own implementation. */
export interface SettingsFileGateway {
	saveJson(defaultName: string, content: string): Promise<boolean>;
	openJson(): Promise<string | undefined>;
}

/** Desktop implementation using VS Code dialogs and the workspace file system. */
export class VscodeSettingsFileGateway implements SettingsFileGateway {

	async saveJson(defaultName: string, content: string): Promise<boolean> {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const defaultUri = folder ? vscode.Uri.joinPath(folder, defaultName) : undefined;
		const target = await vscode.window.showSaveDialog({
			saveLabel: 'Export',
			filters: { 'JSON': ['json'] },
			...(defaultUri ? { defaultUri } : {}),
		});
		if (!target) {
			return false;
		}
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
		return true;
	}

	async openJson(): Promise<string | undefined> {
		const selection = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Import',
			filters: { 'JSON': ['json'] },
		});
		if (!selection || selection.length === 0) {
			return undefined;
		}
		const bytes = await vscode.workspace.fs.readFile(selection[0]);
		return new TextDecoder('utf-8').decode(bytes);
	}
}

export function registerExportImport(context: vscode.ExtensionContext): void {
	const gateway = new VscodeSettingsFileGateway();
	context.subscriptions.push(
		vscode.commands.registerCommand('quasi.settings.export', () => exportSettings(gateway))
	);
}

async function exportSettings(gateway: SettingsFileGateway): Promise<void> {
	const { providers, problems } = readProviders();
	if (problems.length > 0) {
		void vscode.window.showWarningMessage(`Quasi: skipping invalid provider entries during export: ${problems.join(' ')}`);
	}

	const invalid = providers
		.map(provider => ({ id: provider.id, problem: validateProviderBaseUrl(provider.baseUrl) }))
		.filter((entry): entry is { id: string; problem: string } => !!entry.problem);
	if (invalid.length > 0) {
		void vscode.window.showErrorMessage(`Quasi: cannot export invalid provider URL(s): ${invalid.map(entry => `${entry.id}: ${entry.problem}`).join('; ')}`);
		return;
	}

	const activeProviderId = readActiveProviderId();
	const activeModel = readActiveModel();
	const settings: QuasiSettingsV1 = {
		version: SETTINGS_VERSION,
		providers,
		defaults: readDefaults(),
		...(activeProviderId !== undefined ? { activeProviderId } : {}),
		...(activeModel !== undefined ? { activeModel } : {}),
	};

	// Defensive: never write key-like values or secret-named properties.
	const suspicious = scanForSecrets(settings);
	if (suspicious.length > 0) {
		void vscode.window.showErrorMessage(`Quasi: refusing to export; possible secret(s) found at ${suspicious.join(', ')}.`);
		return;
	}

	const saved = await gateway.saveJson('quasi-settings.json', serializeQuasiSettings(settings));
	if (saved) {
		void vscode.window.showInformationMessage(`Quasi: exported ${providers.length} provider(s). No keys were included.`);
	}
}
