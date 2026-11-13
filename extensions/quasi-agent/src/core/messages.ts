/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownBlock } from './markdown';
import { ChatMessage } from './providerApi';

/**
 * Conversation entry model. M1 uses user/assistant/notice. Later milestones add
 * tool-call and tool-result entries; the discriminator keeps that additive.
 */
export type ConversationEntry =
	| { readonly kind: 'user'; readonly text: string }
	| { readonly kind: 'assistant'; readonly text: string; readonly id?: string; readonly blocks?: ReadonlyArray<MarkdownBlock> }
	| { readonly kind: 'notice'; readonly text: string }
	| { readonly kind: 'tool'; readonly name: string; readonly args: string; readonly summary: string; readonly isError: boolean };

/** Map conversation entries to provider messages. Notices are UI-only. */
export function toProviderMessages(entries: ReadonlyArray<ConversationEntry>, system?: string): ChatMessage[] {
	const messages: ChatMessage[] = [];
	if (system) {
		messages.push({ role: 'system', content: system });
	}
	for (const entry of entries) {
		if (entry.kind === 'user') {
			messages.push({ role: 'user', content: entry.text });
		} else if (entry.kind === 'assistant' && entry.text.length > 0) {
			messages.push({ role: 'assistant', content: entry.text });
		}
	}
	return messages;
}

/**
 * Remove an assistant entry that never received any text (an error or Stop
 * before output). Returns true when it was removed. Partial text is kept.
 */
export function dropEmptyAssistant<T extends { readonly kind: string; readonly text?: string }>(entries: T[], entry: T): boolean {
	if (entry.kind !== 'assistant' || (entry.text ?? '').length > 0) {
		return false;
	}
	const index = entries.indexOf(entry);
	if (index === -1) {
		return false;
	}
	entries.splice(index, 1);
	return true;
}
