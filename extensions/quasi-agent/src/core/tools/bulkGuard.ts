/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Asks once per user message after this many automatic (non-approval) writes. */
export const BULK_CHANGE_LIMIT = 20;

export type BulkRegistration = 'ok' | 'ask' | 'already-approved';

export class BulkChangeGuard {
	private changed = 0;
	private approvedForMessage = false;

	constructor(private readonly limit: number = BULK_CHANGE_LIMIT) { }

	reset(): void {
		this.changed = 0;
		this.approvedForMessage = false;
	}

	/**
	 * Call before each automatic write. Returns `ask` once the limit is crossed;
	 * the caller must get approval and then call `approve()`.
	 */
	register(): BulkRegistration {
		this.changed++;
		if (this.approvedForMessage) {
			return 'already-approved';
		}
		return this.changed > this.limit ? 'ask' : 'ok';
	}

	approve(): void {
		this.approvedForMessage = true;
	}

	get count(): number {
		return this.changed;
	}
}
