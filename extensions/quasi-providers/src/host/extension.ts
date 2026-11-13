/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { findProvider } from '../core/providerConfig';
import { ProviderConfig } from '../core/types';
import { registerCommands } from './commands';
import { maybeAutoDiscover, registerDiscovery } from './discovery';
import { registerExportImport } from './exportImport';
import { providerFor } from './providerRuntime';
import { KeyStore, VscodeSecretBackend } from './secrets';
import { readActiveModel, readActiveProviderId, readProviders } from './settings';
import { StatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext): void {
	const keyStore = new KeyStore(new VscodeSecretBackend(context.secrets));
	const statusBar = new StatusBar();
	context.subscriptions.push(statusBar);

	let healthGeneration = 0;
	let lastProblemsKey = '';

	const renderStatus = (): ProviderConfig | undefined => {
		const { providers, problems } = readProviders();
		const problemsKey = problems.join('|');
		if (problems.length > 0) {
			if (problemsKey !== lastProblemsKey) {
				lastProblemsKey = problemsKey;
				void vscode.window.showWarningMessage(`Quasi: ${problems.join(' ')}`);
			}
		} else {
			lastProblemsKey = '';
		}

		const activeId = readActiveProviderId();
		const active = activeId ? findProvider(providers, activeId) : undefined;
		statusBar.update({
			hasProviders: providers.length > 0,
			providerName: active?.name,
			model: active ? readActiveModel() : undefined,
		});
		return active;
	};

	const autoCheckLocal = (active: ProviderConfig | undefined): void => {
		const generation = ++healthGeneration;
		if (!active || active.kind !== 'local') {
			return; // never auto-check cloud providers
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		void (async () => {
			try {
				await providerFor(active, keyStore).listModels(controller.signal);
				if (generation === healthGeneration) {
					statusBar.setState('online');
				}
			} catch {
				if (generation === healthGeneration) {
					statusBar.setState('offline');
				}
			} finally {
				clearTimeout(timeout);
			}
		})();
	};

	statusBar.setState('unknown');
	autoCheckLocal(renderStatus());

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('quasi.providers') || e.affectsConfiguration('quasi.activeProviderId') || e.affectsConfiguration('quasi.activeModel')) {
			statusBar.setState('unknown');
			autoCheckLocal(renderStatus());
		}
	}));

	registerCommands(context, { keyStore, statusBar });
	registerDiscovery(context);
	registerExportImport(context, { keyStore, statusBar });
	void maybeAutoDiscover(context);
}
