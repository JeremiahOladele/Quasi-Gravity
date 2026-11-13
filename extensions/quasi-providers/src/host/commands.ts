/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { checkApiKey, KeyCheck, KeyCheckStatus } from '../core/keyCheck';
import { detectProviderIdsForKey, normalizeKey } from '../core/keyDetect';
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
import { createProvider } from '../core/providers/factory';
import { ProviderPreset, providerPresets } from '../core/providers/presets';
import { ModelInfo, ProviderConfig, ProviderError } from '../core/types';
import { providerFor } from './providerRuntime';
import { KeyStore, SetKeyResult } from './secrets';
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
	register('quasi.provider.quickAdd', () => quickAddCommand(services));
	register('quasi.provider.edit', () => editProviderCommand(services));
	register('quasi.provider.remove', () => removeProviderCommand(services));
	register('quasi.provider.setKey', () => setApiKeyCommand(services));
	register('quasi.provider.testConnection', () => testConnectionCommand(services));
	register('quasi.provider.selectModel', () => selectModelCommand(services));
	register('quasi.provider.menu', () => statusBarMenuCommand(services));
	register('quasi.provider.clearActiveModel', () => clearActiveModelCommand());
	register('quasi.provider.test', () => testProviderCommand(services, output));
}

//#region Add / Edit / Remove

async function addProviderCommand(services: CommandServices): Promise<void> {
	type AddItem =
		| { label: string; description?: string; choice: 'quick' }
		| { label: string; description?: string; choice: 'preset'; preset: ProviderPreset };

	const items: AddItem[] = [
		{ label: '$(key) Quick add: paste an API key', description: 'Detect the provider from the key', choice: 'quick' },
		...providerPresets.map(preset => ({ label: preset.label, description: describePreset(preset), choice: 'preset' as const, preset })),
	];

	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a provider preset' });
	if (!pick) {
		return;
	}
	if (pick.choice === 'quick') {
		await quickAddCommand(services);
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
	if (preset.id === 'custom') {
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
	};

	if (!requiresKey) {
		// Local servers need no key: save as before, then pick a model.
		await writeProviders(appendProvider(providers, config));
		await pickModelForProvider(services, config);
		void vscode.window.showInformationMessage(`Quasi: provider '${config.name}' added.`);
		return;
	}

	if (key === undefined) {
		return;
	}

	// Key-requiring provider: verify and choose a model with the in-memory key,
	// and only persist (provider + key) after a model is selected.
	const listed = await listModelsWithKey(config, key);
	if (!listed.ok) {
		if (listed.status === 401 || listed.status === 403) {
			await offerSetApiKey(config.name);
			return;
		}
		if (listed.status !== 404 && listed.status !== 405) {
			void vscode.window.showErrorMessage(`Quasi: could not reach '${hostOf(baseUrl) ?? baseUrl}'. Nothing was saved. ${listed.message ?? ''}`);
			return;
		}
		// 404/405: no /models endpoint; fall through so the user can enter one.
	}

	const keyStatus = (await checkApiKey(keyCheckForBaseUrl(preset, baseUrl), key)).status;
	if (keyStatus === 'rejected') {
		void vscode.window.showErrorMessage(`Quasi: the API key was rejected by '${hostOf(baseUrl) ?? baseUrl}'. Nothing was saved.`);
		return;
	}
	reportKeyStatus(keyStatus);

	const model = await chooseModelId(config.name, listed.models, undefined);
	if (model === undefined) {
		return; // cancelled: save nothing
	}

	if (keyStatus !== 'verified') {
		const outcome = await maybeVerifyWithMessage(config, key, model);
		if (outcome === 'rejected') {
			void vscode.window.showErrorMessage('Quasi: the API key was rejected by the test message. Nothing was saved.');
			return;
		}
		if (outcome === 'error') {
			void vscode.window.showErrorMessage('Quasi: the verification message failed. Nothing was saved.');
			return;
		}
		if (outcome === 'verified') {
			void vscode.window.showInformationMessage('Quasi: key verified.');
		}
	}

	await writeProviders(appendProvider(providers, config));
	await storeKey(services, id, key);
	await writeActiveProviderId(id);
	await writeActiveModel(model);
	void vscode.window.showInformationMessage(`Quasi: provider '${config.name}' added.`);
}

//#region Quick add

type QuickAddItem =
	| { label: string; description?: string; choice: 'preset'; preset: ProviderPreset }
	| { label: string; description?: string; choice: 'other' };

async function quickAddCommand(services: CommandServices): Promise<void> {
	const keyInput = await promptKey();
	if (keyInput === undefined || keyInput.trim().length === 0) {
		return;
	}
	const key = normalizeKey(keyInput);

	const candidates = detectProviderIdsForKey(key)
		.map(id => providerPresets.find(preset => preset.id === id))
		.filter((preset): preset is ProviderPreset => preset !== undefined);

	// Mandatory confirmation: the user picks the host that receives the key.
	const preset = await confirmQuickAddHost(candidates);
	if (!preset) {
		return; // cancelled: discard the in-memory key
	}

	let baseUrl = preset.config.baseUrl;
	if (preset.id === 'custom') {
		const entered = await promptBaseUrl('');
		if (entered === undefined) {
			return;
		}
		baseUrl = entered;
	}
	if (!(await confirmInsecure(baseUrl))) {
		return;
	}

	const tempConfig: ProviderConfig = {
		id: 'quick-add',
		name: preset.config.name,
		kind: preset.config.kind,
		apiType: preset.config.apiType,
		baseUrl,
		requiresKey: true,
	};

	// List models with the in-memory key only. This is never persisted yet, and
	// the key is never sent anywhere but the host just confirmed above.
	const listed = await listModelsWithKey(tempConfig, key);
	if (!listed.ok) {
		if (listed.status === 401 || listed.status === 403) {
			await offerSetApiKey(tempConfig.name);
			return;
		}
		if (listed.status !== 404 && listed.status !== 405) {
			void vscode.window.showErrorMessage(`Quasi: could not connect to '${hostOf(baseUrl) ?? baseUrl}'. Nothing was saved. ${listed.message ?? ''}`);
			return;
		}
		// 404/405: the server does not expose /models; offer manual model entry.
	}

	// A model list alone does not prove the key is valid. Only claim success if
	// an authenticated check passed.
	const keyStatus = (await checkApiKey(keyCheckForBaseUrl(preset, baseUrl), key)).status;
	if (keyStatus === 'rejected') {
		void vscode.window.showErrorMessage(`Quasi: the API key was rejected by '${hostOf(baseUrl) ?? baseUrl}'. Nothing was saved.`);
		return;
	}
	reportKeyStatus(keyStatus);

	const model = await chooseModelId(preset.config.name, listed.models, undefined);
	if (model === undefined) {
		return; // cancelled: discard the in-memory key, save nothing
	}

	if (keyStatus !== 'verified') {
		const outcome = await maybeVerifyWithMessage(tempConfig, key, model);
		if (outcome === 'rejected') {
			void vscode.window.showErrorMessage('Quasi: the API key was rejected by the test message. Nothing was saved.');
			return;
		}
		if (outcome === 'error') {
			void vscode.window.showErrorMessage('Quasi: the verification message failed. Nothing was saved.');
			return;
		}
		if (outcome === 'verified') {
			void vscode.window.showInformationMessage('Quasi: key verified.');
		}
	}

	// The key and provider are only persisted now, after the user confirmed a model.
	const { providers } = readProviders();
	const id = uniqueProviderId(slugify(preset.config.name), providers.map(existing => existing.id));
	const config: ProviderConfig = { ...tempConfig, id };
	await writeProviders(appendProvider(providers, config));
	const keyResult = await services.keyStore.setKey(providerKeyId(id), key);
	await writeActiveProviderId(id);
	await writeActiveModel(model);
	await reportKeySaved(keyResult);

	void vscode.window.showInformationMessage(`Quasi: provider '${config.name}' added.`);
}

async function confirmQuickAddHost(candidates: ReadonlyArray<ProviderPreset>): Promise<ProviderPreset | undefined> {
	const toItem = (preset: ProviderPreset): QuickAddItem => ({
		label: preset.label,
		description: describeQuickAddPreset(preset),
		choice: 'preset',
		preset
	});
	const cloudPresets = providerPresets.filter(preset => preset.config.requiresKey);

	if (candidates.length === 0) {
		const picked = await vscode.window.showQuickPick(
			cloudPresets.map(toItem),
			{ placeHolder: 'Choose the provider that issued this key' }
		);
		return picked && picked.choice === 'preset' ? picked.preset : undefined;
	}

	const items: QuickAddItem[] = [
		...candidates.map(toItem),
		{ label: '$(list-unordered) Choose another provider…', description: 'None of these? Pick from the full list', choice: 'other' }
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Confirm the host that will receive this key' });
	if (!picked) {
		return undefined;
	}
	if (picked.choice === 'preset') {
		return picked.preset;
	}

	const other = await vscode.window.showQuickPick(cloudPresets.map(toItem), { placeHolder: 'Choose the provider that issued this key' });
	return other && other.choice === 'preset' ? other.preset : undefined;
}

function describeQuickAddPreset(preset: ProviderPreset): string {
	const host = hostOf(preset.config.baseUrl) ?? preset.config.baseUrl;
	const base = describePreset(preset);
	return base ? `${host} · ${base}` : host;
}

//#endregion

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

	await pickModelForProvider(services, provider);
}

/** Sets the provider active and lets the user choose a model for it. */
async function pickModelForProvider(services: CommandServices, provider: ProviderConfig): Promise<void> {
	await writeActiveProviderId(provider.id);

	let models: ModelInfo[] = [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		models = await providerFor(provider, services.keyStore).listModels(controller.signal);
		services.statusBar.setState('online');
	} catch (err) {
		if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
			services.statusBar.setState('rejected');
			await offerSetApiKey(provider.name);
			return;
		}
		services.statusBar.setState('offline');
		// 404/405/other: fall through to manual model entry.
	} finally {
		clearTimeout(timeout);
	}

	const model = await chooseModelId(provider.name, models, readActiveModel() ?? provider.defaultModel);
	if (model === undefined) {
		return;
	}
	await writeActiveModel(model);
}

//#endregion

//#region Status bar menu

interface IMenuAction extends vscode.QuickPickItem {
	readonly action: 'model' | 'provider' | 'add' | 'manage' | 'clear';
}

async function statusBarMenuCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const items: IMenuAction[] = [];

	if (providers.length === 0) {
		items.push({ label: '$(add) Add provider', action: 'add' });
	} else {
		items.push({ label: '$(symbol-method) Switch model', action: 'model' });
		if (providers.length >= 2) {
			items.push({ label: '$(arrow-swap) Switch provider', action: 'provider' });
		}
		items.push({ label: '$(add) Add provider', action: 'add' });
		items.push({ label: '$(settings-gear) Manage providers…', action: 'manage' });
		if (readActiveProviderId() || readActiveModel()) {
			items.push({ label: '$(clear-all) Clear active model', action: 'clear' });
		}
	}

	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Quasi providers' });
	if (!picked) {
		return;
	}

	switch (picked.action) {
		case 'model':
			await selectModelCommand(services);
			break;
		case 'provider':
			await switchProviderCommand(services);
			break;
		case 'add':
			await addProviderCommand(services);
			break;
		case 'manage':
			await manageProvidersCommand(services);
			break;
		case 'clear':
			await clearActiveModelCommand();
			break;
	}
}

async function switchProviderCommand(services: CommandServices): Promise<void> {
	const { providers } = readProviders();
	const provider = await pickProvider(providers, 'Select the active provider');
	if (!provider) {
		return;
	}
	await pickModelForProvider(services, provider);
}

async function manageProvidersCommand(services: CommandServices): Promise<void> {
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(edit) Edit provider', action: 'edit' },
			{ label: '$(trash) Remove provider', action: 'remove' },
			{ label: '$(key) Set API key', action: 'setKey' },
			{ label: '$(plug) Test connection', action: 'test' },
		],
		{ placeHolder: 'Manage providers' }
	);
	if (!picked) {
		return;
	}
	switch (picked.action) {
		case 'edit':
			await editProviderCommand(services);
			break;
		case 'remove':
			await removeProviderCommand(services);
			break;
		case 'setKey':
			await setApiKeyCommand(services);
			break;
		case 'test':
			await testConnectionCommand(services);
			break;
	}
}

async function clearActiveModelCommand(): Promise<void> {
	await writeActiveProviderId(undefined);
	await writeActiveModel(undefined);
	void vscode.window.showInformationMessage('Quasi: active model cleared. Use the status bar menu to pick one.');
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
					if (chunk.status === 401 || chunk.status === 403) {
						if (readActiveProviderId() === provider.id) {
							services.statusBar.setState('rejected');
						}
						void offerSetApiKey(provider.name);
					}
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

interface ListModelsOutcome {
	readonly ok: boolean;
	readonly models: ModelInfo[];
	readonly status?: number;
	readonly message?: string;
}

/** List models using an in-memory key (never persisted). */
async function listModelsWithKey(config: ProviderConfig, key: string | undefined, timeoutMs = 6000): Promise<ListModelsOutcome> {
	const provider = createProvider(config, async () => key);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const models = await provider.listModels(controller.signal);
		return { ok: true, models };
	} catch (err) {
		if (err instanceof ProviderError) {
			return { ok: false, models: [], status: err.status, message: err.message };
		}
		return { ok: false, models: [], message: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timeout);
	}
}

/** Only use a preset's key check if the base URL host was not changed. */
function keyCheckForBaseUrl(preset: ProviderPreset, baseUrl: string): KeyCheck | undefined {
	if (!preset.keyCheck) {
		return undefined;
	}
	return hostOf(preset.config.baseUrl) === hostOf(baseUrl) ? preset.keyCheck : undefined;
}

function reportKeyStatus(status: KeyCheckStatus): void {
	if (status === 'verified') {
		void vscode.window.showInformationMessage('Quasi: key verified.');
	} else {
		void vscode.window.showInformationMessage('Quasi: model list loaded, but it did not confirm your key. It will be checked on your first message.');
	}
}

type VerifyOutcome = 'verified' | 'rejected' | 'skipped' | 'error';

/** Opt-in, potentially-costly verification by sending a one-token message. */
async function maybeVerifyWithMessage(config: ProviderConfig, key: string, model: string): Promise<VerifyOutcome> {
	const verify = 'Verify key with a test message (may use a few tokens)';
	const choice = await vscode.window.showQuickPick([verify, 'Skip verification'], { placeHolder: 'This key is not verified yet' });
	if (choice !== verify) {
		return 'skipped';
	}

	const provider = createProvider(config, async () => key);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	try {
		for await (const chunk of provider.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 })) {
			if (chunk.type === 'error') {
				return chunk.status === 401 || chunk.status === 403 ? 'rejected' : 'error';
			}
			if (chunk.type === 'text' || chunk.type === 'done') {
				return 'verified';
			}
		}
		return 'error';
	} catch {
		return 'error';
	} finally {
		clearTimeout(timeout);
	}
}

async function offerSetApiKey(providerName: string): Promise<void> {
	const action = await vscode.window.showErrorMessage(`Quasi: the API key for '${providerName}' was rejected.`, 'Set API Key');
	if (action === 'Set API Key') {
		await vscode.commands.executeCommand('quasi.provider.setKey');
	}
}

/** Picker description for a preset, including doc-verification caveats. */
function describePreset(preset: ProviderPreset): string {
	const parts: string[] = [preset.config.kind === 'local' ? 'local' : 'cloud'];
	if (preset.note) {
		parts.push(preset.note);
	}
	if (preset.config.requiresKey && preset.keyPrefixVerified !== true) {
		parts.push('prefix unverified');
	}
	return parts.join(' · ');
}

/** Show a model picker (with a manual-entry option). Undefined means cancelled. */
async function chooseModelId(providerName: string, models: ReadonlyArray<ModelInfo>, active: string | undefined): Promise<string | undefined> {
	const items: Array<vscode.QuickPickItem & { model?: string }> = models.map(model => ({
		label: model.id,
		description: model.name,
		model: model.id
	}));
	items.push({ label: MANUAL_MODEL });

	const picked = await vscode.window.showQuickPick(items, { placeHolder: `Select a model for '${providerName}'`, matchOnDescription: true });
	if (!picked) {
		return undefined;
	}
	if (picked.label === MANUAL_MODEL) {
		const entered = await vscode.window.showInputBox({ prompt: 'Model id', value: active ?? '', ignoreFocusOut: true });
		if (entered === undefined) {
			return undefined;
		}
		return entered.trim() || undefined;
	}
	return picked.model;
}

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
	await reportKeySaved(result);
}

async function reportKeySaved(result: SetKeyResult): Promise<void> {
	if (result.persisted) {
		void vscode.window.showInformationMessage('Quasi: API key saved to secure storage.');
	} else {
		const detail = result.keyringError ? ` (${result.keyringError})` : '';
		void vscode.window.showWarningMessage(
			`Quasi: no system keyring found. The API key is kept for this session only and will not be saved after restart.${detail}`
		);
	}
}

//#endregion
