/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CapabilityState } from '../core/capabilities';
import { Capabilities, Provider } from '../core/types';

export interface ActiveProviderInfo {
	readonly provider: Provider;
	readonly model: string;
	readonly providerId: string;
	readonly providerName: string;
	/** Conservative capabilities for calling code (unknown → false). */
	readonly capabilities: Capabilities;
	/** Three-state capabilities, so a caller can distinguish unknown from unsupported. */
	readonly capabilityStates: { readonly tools: CapabilityState; readonly vision: CapabilityState };
}

/**
 * Small, versioned API exposed by the quasi-providers extension's `activate()`
 * return value. Consumers never reach into provider internals or read keys.
 */
export interface QuasiProvidersApiV1 {
	readonly version: 1;
	getActive(): ActiveProviderInfo | undefined;
	readonly onDidChangeActive: vscode.Event<void>;
	/** Flips the status bar to "key rejected" when the reported provider is active. */
	reportKeyRejected(providerId: string): void;
}
