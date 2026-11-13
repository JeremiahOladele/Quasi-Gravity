/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { assessCapabilities, effectiveCapabilities } from '../core/capabilities';
import { findProvider } from '../core/providerConfig';
import { ProviderConfig } from '../core/types';
import { ActiveProviderInfo, QuasiProvidersApiV1 } from './api';
import { registerCommands } from './commands';
import { maybeFirstRun, registerDiscovery } from './discovery';
import { registerExportImport } from './exportImport';
import { providerFor } from './providerRuntime';
import { registerSafetyCommand } from './safetyCommands';
import { KeyStore, VscodeSecretBackend } from './secrets';
import { readActiveModel, readActiveProviderId, readProviders } from './settings';
import { StatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext): QuasiProvidersApiV1 {
	const keyStore = new KeyStore(new VscodeSecretBackend(context.secrets));
	const statusBar = new StatusBar();
	context.subscriptions.push(statusBar);

	const onDidChangeActive = new vscode.EventEmitter<void>();
	context.subscriptions.push(onDidChangeActive);

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
			onDidChangeActive.fire();
		}
	}));

	registerCommands(context, { keyStore, statusBar });
	registerDiscovery(context);
	registerExportImport(context, { keyStore, statusBar });
	registerSafetyCommand(context);
	void maybeFirstRun(context);

	const getActive = (): ActiveProviderInfo | undefined => {
		const { providers } = readProviders();
		const activeId = readActiveProviderId();
		const config = activeId ? findProvider(providers, activeId) : undefined;
		const model = readActiveModel();
		if (!config || !model) {
			return undefined;
		}
		try {
			const assessment = assessCapabilities(undefined, config.capabilities);
			return {
				provider: providerFor(config, keyStore),
				model,
				providerId: config.id,
				providerName: config.name,
				capabilities: effectiveCapabilities(assessment),
				capabilityStates: { tools: assessment.tools, vision: assessment.vision },
			};
		} catch {
			return undefined;
		}
	};

	return {
		version: 1,
		getActive,
		onDidChangeActive: onDidChangeActive.event,
		reportKeyRejected: (providerId: string) => {
			if (readActiveProviderId() === providerId) {
				statusBar.setState('rejected');
			}
		},
	};
}
