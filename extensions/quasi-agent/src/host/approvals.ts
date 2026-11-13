/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApprovalBroker, ApprovalGate } from '../core/approvals';
import { ApprovalPrompt } from '../core/tools/registry';

/** Bridges core approval requests to the webview's approval cards. */
export class WebviewApprovalBroker implements ApprovalBroker {

	private readonly gate = new ApprovalGate();

	constructor(private readonly post: (message: unknown) => void) { }

	requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> {
		const { id, promise } = this.gate.create(prompt, signal);
		this.post({ type: 'approvalRequest', id, toolName: prompt.toolName, reason: prompt.reason, detail: prompt.detail });
		return promise.then(approved => {
			this.post({ type: 'approvalResolved', id, approved });
			return approved;
		});
	}

	resolve(id: string, approved: boolean): void {
		this.gate.resolve(id, approved);
	}

	cancelAll(): void {
		this.gate.cancelAll();
	}

	get pendingCount(): number {
		return this.gate.pendingCount;
	}
}
