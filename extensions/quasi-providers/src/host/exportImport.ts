/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { providerKeyId } from '../core/providerConfig';
import {
	ImportPlan,
	QuasiSettingsV1,
	SETTINGS_VERSION,
	filterKnownDefaults,
	parseQuasiSettings,
	planImport,
	scanForSecrets,
	serializeQuasiSettings,
	validateProviderBaseUrl
} from '../core/settingsSchema';
import { ProviderConfig } from '../core/types';
import type { CommandServices } from './commands';
import {
	readActiveModel,
	readActiveProviderId,
	readDefaults,
	readProviders,
	writeActiveModel,
	writeActiveProviderId,
	writeDefaults,
	writeProviders
} from './settings';

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

export function registerExportImport(context: vscode.ExtensionContext, services: CommandServices): void {
	const gateway = new VscodeSettingsFileGateway();
	context.subscriptions.push(
		vscode.commands.registerCommand('quasi.settings.export', () => exportSettings(gateway)),
		vscode.commands.registerCommand('quasi.settings.import', () => importSettings(gateway, services))
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

async function importSettings(gateway: SettingsFileGateway, services: CommandServices): Promise<void> {
	const text = await gateway.openJson();
	if (text === undefined) {
		return;
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		void vscode.window.showErrorMessage(`Quasi: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const parsed = parseQuasiSettings(json);
	if (!parsed.ok || !parsed.value) {
		void vscode.window.showErrorMessage(`Quasi: import rejected.\n${(parsed.problems ?? []).join('\n')}`);
		return;
	}

	const { providers: existing } = readProviders();
	const plan = planImport(existing, parsed.value.providers, readActiveProviderId(), readActiveModel(), parsed.value.activeProviderId, parsed.value.activeModel);

	const confirmed = await vscode.window.showWarningMessage(buildImportSummary(plan, parsed.warnings ?? []), { modal: true }, 'Import');
	if (confirmed !== 'Import') {
		return;
	}

	await writeProviders(plan.providers);
	if (plan.activeChanged) {
		await writeActiveProviderId(plan.activeProviderId);
		await writeActiveModel(plan.activeModel);
	}

	// Only keys this build knows are applied (none until M5); everything else was dropped.
	const knownDefaults = filterKnownDefaults(parsed.value.defaults).value;
	if (Object.keys(knownDefaults).length > 0) {
		await writeDefaults({ ...readDefaults(), ...knownDefaults });
	}

	await warnMissingKeys(services, plan.providers);
	void vscode.window.showInformationMessage(`Quasi: imported settings. Added ${plan.added.length}, updated ${plan.updated.length}, skipped ${plan.skipped.length}.`);
}

function describeProviders(items: ReadonlyArray<{ id: string; host?: string }>): string {
	return items.length === 0 ? 'none' : items.map(item => `${item.id}${item.host ? ` (${item.host})` : ''}`).join(', ');
}

function buildImportSummary(plan: ImportPlan, warnings: ReadonlyArray<string>): string {
	const lines: string[] = ['Quasi: import summary'];
	lines.push(`Added: ${describeProviders(plan.added)}`);
	lines.push(`Updated (same host): ${describeProviders(plan.updated)}`);
	lines.push(plan.conflicts.length === 0
		? 'Conflicts (skipped): none'
		: `Conflicts (skipped): ${plan.conflicts.map(conflict => `${conflict.id} (existing ${conflict.existingHost ?? '?'} vs imported ${conflict.importedHost ?? '?'})`).join('; ')}`);
	lines.push(`Active: ${plan.activeProviderId ?? 'unchanged'}${plan.activeModel ? ` · ${plan.activeModel}` : ''}`);
	lines.push(...warnings);
	lines.push('Import these settings?');
	return lines.join('\n');
}

async function warnMissingKeys(services: CommandServices, providers: ReadonlyArray<ProviderConfig>): Promise<void> {
	const missing: string[] = [];
	for (const provider of providers) {
		if (provider.requiresKey && !(await services.keyStore.hasKey(providerKeyId(provider.id)))) {
			missing.push(provider.name);
		}
	}
	if (missing.length === 0) {
		return;
	}
	const action = await vscode.window.showWarningMessage(
		`Quasi: imported providers need an API key on this device: ${missing.join(', ')}.`,
		'Set API Key'
	);
	if (action === 'Set API Key') {
		await vscode.commands.executeCommand('quasi.provider.setKey');
	}
}
