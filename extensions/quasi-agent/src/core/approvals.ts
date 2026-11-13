/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApprovalPrompt } from './tools/registry';

export interface ApprovalBroker {
	requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean>;
	cancelAll(): void;
}

interface PendingEntry {
	readonly prompt: ApprovalPrompt;
	readonly resolve: (approved: boolean) => void;
}

/**
 * Tracks pending approvals with unguessable, single-use ids. `resolve` only
 * accepts a currently-pending id once; unknown or already-resolved ids are
 * ignored. Aborting the signal cancels that request, and `cancelAll` cancels
 * all pending requests (used by Stop, New Chat and view disposal).
 */
export class ApprovalGate implements ApprovalBroker {
	private readonly pending = new Map<string, PendingEntry>();

	constructor(private readonly newId: () => string = defaultApprovalId) { }

	create(prompt: ApprovalPrompt, signal: AbortSignal): { id: string; promise: Promise<boolean> } {
		const id = this.newId();
		let settle!: (approved: boolean) => void;
		const promise = new Promise<boolean>(resolve => {
			settle = resolve;
		});
		let onAbort: () => void;

		const entry: PendingEntry = {
			prompt,
			resolve: (approved: boolean) => {
				signal.removeEventListener('abort', onAbort);
				settle(approved);
			}
		};

		onAbort = () => {
			if (this.pending.get(id) === entry) {
				this.pending.delete(id);
				entry.resolve(false);
			}
		};

		this.pending.set(id, entry);
		if (signal.aborted) {
			this.pending.delete(id);
			settle(false);
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
		return { id, promise };
	}

	requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> {
		return this.create(prompt, signal).promise;
	}

	resolve(id: string, approved: boolean): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		this.pending.delete(id);
		entry.resolve(approved);
		return true;
	}

	cancelAll(): void {
		for (const [id, entry] of [...this.pending.entries()]) {
			this.pending.delete(id);
			entry.resolve(false);
		}
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	get pendingIds(): string[] {
		return [...this.pending.keys()];
	}
}

function defaultApprovalId(): string {
	const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (cryptoObject?.randomUUID) {
		return cryptoObject.randomUUID();
	}
	return `a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
