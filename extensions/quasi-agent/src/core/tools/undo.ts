/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type UndoKind = 'created' | 'modified' | 'deleted';

export interface UndoRecord {
	readonly id: string;
	/** Workspace-relative, forward-slash path. */
	readonly path: string;
	readonly kind: UndoKind;
	readonly before?: string;
	readonly after?: string;
	readonly bytes: number;
	readonly createdAt: number;
}

/** Undo history lives in memory only and is bounded. */
export const UNDO_MAX_TOTAL_BYTES = 4_000_000;

function defaultUndoId(): string {
	return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class UndoBook {
	private readonly items: UndoRecord[] = [];
	private totalBytes = 0;

	constructor(
		private readonly newId: () => string = defaultUndoId,
		private readonly maxTotalBytes: number = UNDO_MAX_TOTAL_BYTES
	) { }

	/** Returns undefined when a single change is larger than the whole undo budget. */
	record(input: { path: string; kind: UndoKind; before?: string; after?: string }): UndoRecord | undefined {
		const bytes = (input.before?.length ?? 0) + (input.after?.length ?? 0);
		if (bytes > this.maxTotalBytes) {
			return undefined;
		}
		while (this.totalBytes + bytes > this.maxTotalBytes && this.items.length > 0) {
			const evicted = this.items.shift();
			this.totalBytes -= evicted?.bytes ?? 0;
		}
		const record: UndoRecord = {
			id: this.newId(),
			path: input.path,
			kind: input.kind,
			before: input.before,
			after: input.after,
			bytes,
			createdAt: Date.now()
		};
		this.items.push(record);
		this.totalBytes += bytes;
		return record;
	}

	all(): readonly UndoRecord[] {
		return [...this.items];
	}

	find(id: string): UndoRecord | undefined {
		return this.items.find(item => item.id === id);
	}

	remove(id: string): void {
		const index = this.items.findIndex(item => item.id === id);
		if (index !== -1) {
			this.totalBytes -= this.items[index].bytes;
			this.items.splice(index, 1);
		}
	}

	last(): UndoRecord | undefined {
		return this.items[this.items.length - 1];
	}

	get count(): number {
		return this.items.length;
	}

	get empty(): boolean {
		return this.items.length === 0;
	}

	clear(): void {
		this.items.length = 0;
		this.totalBytes = 0;
	}
}

export type RevertAction = 'delete' | 'restore' | 'noop';

export interface RevertDecision {
	readonly action: RevertAction;
	readonly content?: string;
	/** True when the file no longer matches what the agent wrote. */
	readonly conflict: boolean;
}

export function planRevert(record: UndoRecord, current: string | undefined): RevertDecision {
	switch (record.kind) {
		case 'created':
			if (current === undefined) {
				return { action: 'noop', conflict: false };
			}
			return { action: 'delete', conflict: current !== record.after };
		case 'deleted':
			if (current !== undefined) {
				return { action: 'noop', conflict: true };
			}
			return { action: 'restore', content: record.before ?? '', conflict: false };
		case 'modified':
			return { action: 'restore', content: record.before ?? '', conflict: current !== record.after };
	}
}
