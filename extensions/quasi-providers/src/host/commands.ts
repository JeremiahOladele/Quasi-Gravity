/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	addProvider as appendProvider,
	hostOf,
	isInsecureRemoteUrl,
	providerKeyId,
	removeProvider as removeProviderFromList,
	slugify,
	uniqueProviderId,
	updateProvider
} from '../core/providerConfig';
import { providerPresets } from '../core/providers/presets';
import { ModelInfo, ProviderConfig } from '../core/types';
import { providerFor } from './providerRuntime';
import { KeyStore } from './secrets';
import {
	readActiveModel,
	readActiveProviderId,
	readProviders,
	writeActiveModel,
	writeActiveProviderId,
	writeProviders
} from './settings';
import { StatusBar } from './statusBar';

export interface CommandServices {
	readonly keyStore: KeyStore;
	readonly statusBar: StatusBar;
}

const MANUAL_MODEL = '$(edit) Enter model id…';

export function registerCommands(context: vscode.ExtensionContext, services: CommandServices): void {
	const output = vscode.window.createOutputChannel('Quasi: Test Provider');
	context.subscriptions.push(output);

	const register = (id: string, handler: () => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('quasi.provider.add', () => addProviderCommand(services));
	register('quasi.provider.edit', () => editProviderCommand(services));
	register('quasi.provider.remove', () => removeProviderCommand(services));
	register('quasi.provider.setKey', () => setApiKeyCommand(services));
	register('quasi.provider.testConnection', () => testConnectionCommand(services));
	register('quasi.provider.selectModel', () => selectModelCommand(services));
	register('quasi.provider.test', () => testProviderCommand(services, output));
}

//#region Add / Edit / Remove

async function addProviderCommand(services: CommandServices): Promise<void> {
	const pick = await vscode.window.showQuickPick(
		providerPresets.map(preset => ({ label: preset.label, description: preset.config.kind === 'local' ? 'local' : 'cloud', preset })),
		{ placeHolder: 'Choose a provider preset' }
	);
	if (!pick) {
		return;
	}
	const preset = pick.preset;

	const name = await vscode.window.showInputBox({ prompt: 'Provider name', value: preset.config.name, ignoreFocusOut: true });
	if (name === undefined || name.trim().length === 0) {
		return;
	}

	const baseUrl = await promptBaseUrl(preset.config.baseUrl);
	if (baseUrl === undefined) {
		return;
	}

	let requiresKey = preset.config.requiresKey;
	if (preset.label === 'Custom OpenAI-compatible') {
		const answer = await vscode.window.showQuickPick(['Yes (cloud)', 'No (local)'], { placeHolder: 'Does this provider require an API key?' });
		if (!answer) {
			return;
		}
		requiresKey = answer === 'Yes (cloud)';
	}

	if (!(await confirmInsecure(baseUrl))) {
		return;
	}

	let key: string | undefined;
	if (requiresKey) {
		key = await promptKey();
		if (key === undefined) {
			return;
		}
	}

	const { providers } = readProviders();
	const id = uniqueProviderId(slugify(name), providers.map(provider => provider.id));
	const config: ProviderConfig = {
		id,
		name: name.trim(),
		kind: requiresKey ? 'cloud' : 'local',
		apiType: 'openai-compat',
		baseUrl,
		requiresKey,
		...(preset.config.defaultModel ? { defaultModel: preset.config.defaultModel } : {}),
	};

	await writeProviders(appendProvider(providers, config));

	if (requiresKey && key !== undefined) {
		await storeKey(services, id, key);
	}

	if (!readActiveProviderId()) {
		await writeActiveProviderId(id);
		await writeActiveModel(config.defaultModel);
	}

	void vscode.window.showInformationMessage(`Quasi: provider '${config.name}' added.`);
}

async function editProviderCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const provider = await pickProvider(providers, 'Select a provider to edit');
	if (!provider) {
		return;
	}

	const field = await vscode.window.showQuickPick(
		['Name', 'Base URL', 'Default model', 'Requires API key'],
		{ placeHolder: `Edit '${provider.name}'` }
	);
	if (!field) {
		return;
	}

	switch (field) {
		case 'Name': {
			const name = await vscode.window.showInputBox({ prompt: 'Provider name', value: provider.name, ignoreFocusOut: true });
			if (name === undefined || name.trim().length === 0) {
				return;
			}
			await writeProviders(updateProvider(providers, provider.id, { name: name.trim() }));
			break;
		}
		case 'Base URL': {
			const baseUrl = await promptBaseUrl(provider.baseUrl);
			if (baseUrl === undefined) {
				return;
			}
			if (!(await confirmHostChange(services, provider, baseUrl))) {
				return;
			}
			if (!(await confirmInsecure(baseUrl))) {
				return;
			}
			await writeProviders(updateProvider(providers, provider.id, { baseUrl }));
			break;
		}
		case 'Default model': {
			const model = await vscode.window.showInputBox({ prompt: 'Default model id', value: provider.defaultModel ?? '', ignoreFocusOut: true });
			if (model === undefined) {
				return;
			}
			await writeProviders(updateProvider(providers, provider.id, { defaultModel: model.trim() || undefined }));
			break;
		}
		case 'Requires API key': {
			const answer = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Requires an API key?' });
			if (!answer) {
				return;
			}
			const requiresKey = answer === 'Yes';
			await writeProviders(updateProvider(providers, provider.id, { requiresKey, kind: requiresKey ? 'cloud' : 'local' }));
			break;
		}
	}

	void vscode.window.showInformationMessage(`Quasi: provider '${provider.name}' updated.`);
}

async function removeProviderCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const provider = await pickProvider(providers, 'Select a provider to remove');
	if (!provider) {
		return;
	}

	const confirmed = await vscode.window.showWarningMessage(`Remove provider '${provider.name}'?`, { modal: true }, 'Remove');
	if (confirmed !== 'Remove') {
		return;
	}

	await writeProviders(removeProviderFromList(providers, provider.id));
	await services.keyStore.deleteKey(providerKeyId(provider.id));

	if (readActiveProviderId() === provider.id) {
		const next = providers.find(candidate => candidate.id !== provider.id);
		await writeActiveProviderId(next?.id);
		await writeActiveModel(next?.defaultModel);
	}

	void vscode.window.showInformationMessage(`Quasi: provider '${provider.name}' removed.`);
}

//#endregion

//#region Set key / Test connection / Select model

async function setApiKeyCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const provider = await pickProvider(providers, 'Select a provider to set its API key');
	if (!provider) {
		return;
	}

	const key = await promptKey();
	if (key === undefined || key.length === 0) {
		return;
	}
	await storeKey(services, provider.id, key);
}

async function testConnectionCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const provider = await pickProvider(providers, 'Select a provider to test');
	if (!provider) {
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const result = await providerFor(provider, services.keyStore).testConnection(controller.signal);
		const isActive = readActiveProviderId() === provider.id;
		if (result.ok) {
			if (isActive) {
				services.statusBar.setState('online');
			}
			const count = result.models?.length;
			const suffix = count !== undefined ? ` (${count} model${count === 1 ? '' : 's'})` : '';
			void vscode.window.showInformationMessage(`Quasi: connection OK for '${provider.name}'${suffix}.`);
		} else {
			if (isActive) {
				services.statusBar.setState('offline');
			}
			void vscode.window.showErrorMessage(`Quasi: connection failed for '${provider.name}': ${result.message}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

async function selectModelCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	if (providers.length === 0) {
		const add = await vscode.window.showInformationMessage('Quasi: no providers configured yet.', 'Add Provider');
		if (add === 'Add Provider') {
			await addProviderCommand(services);
		}
		return;
	}

	let provider: ProviderConfig | undefined;
	if (providers.length === 1) {
		provider = providers[0];
	} else {
		provider = await pickProvider(providers, 'Select a provider');
		if (!provider) {
			return;
		}
	}

	await writeActiveProviderId(provider.id);

	let models: ModelInfo[] = [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		models = await providerFor(provider, services.keyStore).listModels(controller.signal);
		services.statusBar.setState('online');
	} catch {
		services.statusBar.setState('offline');
		// Fall through: allow choosing the default model or entering one manually.
	} finally {
		clearTimeout(timeout);
	}

	const active = readActiveModel();
	const items: Array<vscode.QuickPickItem & { model?: string }> = models.map(model => ({
		label: model.id,
		description: model.name,
		model: model.id
	}));
	items.push({ label: MANUAL_MODEL, description: provider.defaultModel ? `default: ${provider.defaultModel}` : undefined });

	const picked = await vscode.window.showQuickPick(items, { placeHolder: `Select a model for '${provider.name}'`, matchOnDescription: true });
	if (!picked) {
		return;
	}

	let model: string | undefined;
	if (picked.label === MANUAL_MODEL) {
		model = await vscode.window.showInputBox({ prompt: 'Model id', value: active ?? provider.defaultModel ?? '', ignoreFocusOut: true });
		if (model === undefined) {
			return;
		}
	} else {
		model = picked.model;
	}

	await writeActiveModel(model?.trim() || undefined);
}

//#endregion

//#region Dev streaming test

async function testProviderCommand(services: CommandServices, output: vscode.OutputChannel): Promise<void> {
	const { providers } = readProviders();
	if (providers.length === 0) {
		const add = await vscode.window.showInformationMessage('Quasi: no providers configured yet.', 'Add Provider');
		if (add === 'Add Provider') {
			await addProviderCommand(services);
		}
		return;
	}

	const provider = await pickProvider(providers, 'Select a provider to test');
	if (!provider) {
		return;
	}

	const model = await vscode.window.showInputBox({
		prompt: 'Model',
		value: readActiveModel() ?? provider.defaultModel ?? '',
		ignoreFocusOut: true,
	});
	if (model === undefined || model.trim().length === 0) {
		return;
	}

	const message = await vscode.window.showInputBox({ prompt: 'Message to send', value: 'Say hello', ignoreFocusOut: true });
	if (message === undefined) {
		return;
	}

	output.show();
	output.appendLine(`Provider: ${provider.name} (${provider.baseUrl})`);
	output.appendLine(`Model: ${model}`);
	output.appendLine('---');
	output.appendLine(`> ${message}`);
	output.appendLine('');

	try {
		for await (const chunk of providerFor(provider, services.keyStore).chat({ model, messages: [{ role: 'user', content: message }] })) {
			switch (chunk.type) {
				case 'text':
					output.append(chunk.text);
					break;
				case 'toolCall':
					output.appendLine('');
					output.appendLine(`[tool call: ${chunk.call.function.name}(${chunk.call.function.arguments})]`);
					break;
				case 'done':
					output.appendLine('');
					if (chunk.usage) {
						output.appendLine(`[usage: ${chunk.usage.inputTokens ?? '?'} in / ${chunk.usage.outputTokens ?? '?'} out]`);
					}
					output.appendLine('[done]');
					break;
				case 'error':
					output.appendLine('');
					output.appendLine(`[error] ${chunk.message}`);
					break;
			}
		}
	} catch (err) {
		output.appendLine('');
		output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
	}
}

//#endregion

//#region Helpers

async function pickProvider(providers: ReadonlyArray<ProviderConfig>, placeHolder: string): Promise<ProviderConfig | undefined> {
	if (providers.length === 0) {
		void vscode.window.showInformationMessage('Quasi: no providers configured yet.');
		return undefined;
	}
	const activeId = readActiveProviderId();
	const picked = await vscode.window.showQuickPick(
		providers.map(provider => ({
			label: provider.name,
			description: provider.baseUrl,
			detail: provider.id === activeId ? 'active' : undefined,
			provider
		})),
		{ placeHolder, matchOnDescription: true }
	);
	return picked?.provider;
}

async function promptBaseUrl(initial: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		prompt: 'Base URL (OpenAI-compatible)',
		value: initial,
		ignoreFocusOut: true,
		validateInput: input => {
			const trimmed = input.trim();
			if (!trimmed) {
				return 'Base URL is required';
			}
			try {
				const parsed = new URL(trimmed);
				if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
					return 'URL must start with http:// or https://';
				}
			} catch {
				return 'Enter a valid URL';
			}
			return undefined;
		}
	});
	if (value === undefined) {
		return undefined;
	}
	return value.trim().replace(/\/+$/, '');
}

async function promptKey(): Promise<string | undefined> {
	return vscode.window.showInputBox({
		prompt: 'API key (stored in SecretStorage, never logged)',
		password: true,
		ignoreFocusOut: true,
	});
}

async function confirmInsecure(baseUrl: string): Promise<boolean> {
	if (!isInsecureRemoteUrl(baseUrl)) {
		return true;
	}
	const host = hostOf(baseUrl) ?? baseUrl;
	const answer = await vscode.window.showWarningMessage(
		`'${host}' is not HTTPS. Prompts and API keys may be sent unencrypted.`,
		{ modal: true },
		'Save anyway'
	);
	return answer === 'Save anyway';
}

async function confirmHostChange(services: CommandServices, provider: ProviderConfig, newBaseUrl: string): Promise<boolean> {
	const oldHost = hostOf(provider.baseUrl);
	const newHost = hostOf(newBaseUrl);
	if (!newHost || oldHost === newHost) {
		return true;
	}
	if (!(await services.keyStore.hasKey(providerKeyId(provider.id)))) {
		return true;
	}
	const answer = await vscode.window.showWarningMessage(
		`Change the base URL host to '${newHost}'? Your saved API key will be sent to that host.`,
		{ modal: true },
		'Change host'
	);
	return answer === 'Change host';
}

async function storeKey(services: CommandServices, providerId: string, key: string): Promise<void> {
	const result = await services.keyStore.setKey(providerKeyId(providerId), key);
	if (result.persisted) {
		void vscode.window.showInformationMessage('Quasi: API key saved to the OS keyring.');
	} else {
		const detail = result.keyringError ? ` (${result.keyringError})` : '';
		void vscode.window.showWarningMessage(
			`Quasi: no system keyring found. The API key is kept for this session only and will not be saved after restart.${detail}`
		);
	}
}

//#endregion
