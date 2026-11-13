/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProvidersReadResult, readProvidersSafe } from '../core/providerConfig';
import { ProviderConfig } from '../core/types';

const SECTION = 'quasi';

// QUASI: every quasi.* setting is application-scoped on purpose. A workspace
// must never be able to override providers, or a malicious repo could redirect
// an API key to another host.

function configuration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(SECTION);
}

/** Read and validate `quasi.providers`; never throws. */
export function readProviders(): ProvidersReadResult {
	return readProvidersSafe(configuration().get<unknown>('providers'));
}

export async function writeProviders(providers: ProviderConfig[]): Promise<void> {
	await configuration().update('providers', providers, vscode.ConfigurationTarget.Global);
}

export function readActiveProviderId(): string | undefined {
	const value = configuration().get<string>('activeProviderId');
	return value ? value : undefined;
}

export async function writeActiveProviderId(id: string | undefined): Promise<void> {
	await configuration().update('activeProviderId', id ?? '', vscode.ConfigurationTarget.Global);
}

export function readActiveModel(): string | undefined {
	const value = configuration().get<string>('activeModel');
	return value ? value : undefined;
}

export async function writeActiveModel(model: string | undefined): Promise<void> {
	await configuration().update('activeModel', model ?? '', vscode.ConfigurationTarget.Global);
}

export function readDiscoveryDontAskAgain(): boolean {
	return configuration().get<boolean>('discovery.dontAskAgain', false);
}

export async function writeDiscoveryDontAskAgain(value: boolean): Promise<void> {
	await configuration().update('discovery.dontAskAgain', value, vscode.ConfigurationTarget.Global);
}

export function readDefaults(): Record<string, unknown> {
	const value = configuration().get<Record<string, unknown>>('defaults');
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

export async function writeDefaults(value: Record<string, unknown>): Promise<void> {
	await configuration().update('defaults', value, vscode.ConfigurationTarget.Global);
}
