/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiscoveredServer, probeLocalServers } from '../core/discovery';
import { addProvider as appendProvider, slugify, uniqueProviderId } from '../core/providerConfig';
import { ProviderConfig } from '../core/types';
import { readDiscoveryDontAskAgain, readProviders, writeDiscoveryDontAskAgain, writeProviders } from './settings';

const AUTO_RAN_KEY = 'quasi.discovery.autoRan';

export function registerDiscovery(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quasi.discovery.detectLocalModels', () => detectLocalModels(true))
	);
}

/** Run discovery once per install (unless the user opted out). */
export async function maybeAutoDiscover(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(AUTO_RAN_KEY)) {
		return;
	}
	await context.globalState.update(AUTO_RAN_KEY, true);
	if (readDiscoveryDontAskAgain()) {
		return;
	}
	await detectLocalModels(false);
}

function originOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}

async function addServers(servers: ReadonlyArray<DiscoveredServer>): Promise<void> {
	const { providers } = readProviders();
	let next: ProviderConfig[] = [...providers];
	const added: string[] = [];
	for (const server of servers) {
		const id = uniqueProviderId(slugify(server.label), next.map(provider => provider.id));
		next = appendProvider(next, {
			id,
			name: server.label,
			kind: 'local',
			apiType: server.apiType,
			baseUrl: server.baseUrl,
			requiresKey: false,
		});
		added.push(server.label);
	}
	await writeProviders(next);
	void vscode.window.showInformationMessage(`Quasi: added local provider(s): ${added.join(', ')}.`);
}

async function detectLocalModels(interactive: boolean): Promise<void> {
	const found = await probeLocalServers();
	const { providers } = readProviders();
	const configured = new Set(providers.map(provider => originOf(provider.baseUrl)).filter((origin): origin is string => !!origin));
	const candidates = found.filter(server => {
		const origin = originOf(server.baseUrl);
		return origin ? !configured.has(origin) : false;
	});

	if (candidates.length === 0) {
		if (interactive) {
			void vscode.window.showInformationMessage('Quasi: no new local model servers found.');
		}
		return;
	}

	// Automatic startup: ask with a non-modal notification when there is one server.
	if (!interactive && candidates.length === 1) {
		const server = candidates[0];
		const action = await vscode.window.showInformationMessage(
			`Quasi: found ${server.label} on :${server.port}. Add it?`,
			'Add',
			'Not now',
			'Don\'t ask again'
		);
		if (action === 'Add') {
			await addServers([server]);
		} else if (action === 'Don\'t ask again') {
			await writeDiscoveryDontAskAgain(true);
		}
		return;
	}

	const items: Array<vscode.QuickPickItem & { server?: DiscoveredServer; dontAsk?: boolean }> = candidates.map(server => ({
		label: `$(server) ${server.label} on :${server.port}`,
		description: server.baseUrl,
		detail: server.models.length > 0 ? `${server.models.length} model${server.models.length === 1 ? '' : 's'}` : 'no models reported',
		server
	}));
	items.push({ label: '$(bell-slash) Don\'t ask again', description: 'Skip future automatic discovery prompts', dontAsk: true });

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Found local model servers — select the ones to add'
	});
	if (!picked) {
		return;
	}
	if (picked.some(item => item.dontAsk)) {
		await writeDiscoveryDontAskAgain(true);
	}
	const servers = picked.map(item => item.server).filter((server): server is DiscoveredServer => !!server);
	if (servers.length > 0) {
		await addServers(servers);
	}
}
