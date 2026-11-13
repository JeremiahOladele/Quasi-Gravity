/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { redactSecrets } from '../core/redact';

/**
 * Minimal secret-store abstraction. The real implementation wraps
 * `vscode.ExtensionContext.secrets`; tests use a fake. Keeping `KeyStore` free
 * of `vscode` imports makes the keyring-failure logic unit-testable.
 */
export interface SecretBackend {
	get(key: string): Promise<string | undefined>;
	store(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface GetKeyResult {
	readonly key?: string;
	readonly keyringError?: string;
}

export interface SetKeyResult {
	readonly persisted: boolean;
	readonly keyringError?: string;
}

/**
 * Wraps a `SecretBackend` and adds keyring-failure handling:
 * - every backend call is guarded by try/catch (SecretStorage can throw on
 *   Linux/WSL when no system keyring exists);
 * - on failure the key is kept in memory for this session only, never written
 *   to settings or any file;
 * - keyring errors are redacted so they can never contain the key.
 */
export class KeyStore {

	private readonly session = new Map<string, string>();
	private readonly sessionErrors = new Map<string, string>();

	constructor(private readonly backend: SecretBackend) { }

	async getKey(id: string): Promise<GetKeyResult> {
		let keyringError: string | undefined;
		try {
			const value = await this.backend.get(id);
			if (value !== undefined) {
				return { key: value };
			}
		} catch (err) {
			keyringError = redactSecrets(errorMessage(err), this.session.get(id));
		}

		const sessionKey = this.session.get(id);
		if (sessionKey !== undefined) {
			const sessionError = this.sessionErrors.get(id) ?? keyringError;
			return sessionError ? { key: sessionKey, keyringError: sessionError } : { key: sessionKey };
		}
		return keyringError ? { keyringError } : {};
	}

	async setKey(id: string, key: string): Promise<SetKeyResult> {
		try {
			await this.backend.store(id, key);
			this.session.delete(id);
			this.sessionErrors.delete(id);
			return { persisted: true };
		} catch (err) {
			const keyringError = redactSecrets(errorMessage(err), key);
			this.session.set(id, key);
			this.sessionErrors.set(id, keyringError);
			return { persisted: false, keyringError };
		}
	}

	async deleteKey(id: string): Promise<void> {
		this.session.delete(id);
		this.sessionErrors.delete(id);
		try {
			await this.backend.delete(id);
		} catch {
			// Never throw: removing a provider must not fail because the keyring is unavailable.
		}
	}

	async hasKey(id: string): Promise<boolean> {
		if (this.session.has(id)) {
			return true;
		}
		try {
			return (await this.backend.get(id)) !== undefined;
		} catch {
			return false;
		}
	}
}

/** Structural shape of `vscode.SecretStorage` that we need. */
export interface VscodeSecretsLike {
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
	delete(key: string): PromiseLike<void>;
}

/** Adapts `vscode.ExtensionContext.secrets` to a `SecretBackend`. */
export class VscodeSecretBackend implements SecretBackend {
	constructor(private readonly secrets: VscodeSecretsLike) { }

	get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.secrets.get(key));
	}

	store(key: string, value: string): Promise<void> {
		return Promise.resolve(this.secrets.store(key, value));
	}

	delete(key: string): Promise<void> {
		return Promise.resolve(this.secrets.delete(key));
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
