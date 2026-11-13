/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	SAFETY_PROFILES,
	SafetyPermissions,
	TerminalPermission,
	permissionsForProfile,
	profileForPermissions
} from '../core/safetyDefaults';
import { readDefaults, writeDefaults } from './settings';

type ProfileId = 'safe' | 'balanced' | 'autonomous';

interface MenuItem extends vscode.QuickPickItem {
	readonly action?: 'profile' | 'terminal' | 'write';
	readonly profile?: ProfileId;
}

export function registerSafetyCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quasi.settings.setSafetyProfile', () => setSafetyProfile())
	);
}

async function setSafetyProfile(): Promise<void> {
	const current = readDefaults();

	const items: MenuItem[] = [
		...SAFETY_PROFILES.map(definition => ({
			label: `${current.profile === definition.id ? '$(check)' : '$(circle-outline)'} ${definition.label}`,
			description: current.profile === definition.id ? 'current' : undefined,
			detail: definition.description,
			action: 'profile' as const,
			profile: definition.id
		})),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: `$(terminal) Ask before terminal commands: ${current.permissions.askBeforeTerminal}`, action: 'terminal' as const },
		{ label: `$(edit) Ask before writing outside the workspace: ${current.permissions.askBeforeWriteOutsideWorkspace ? 'On' : 'Off'}`, action: 'write' as const }
	];

	const picked = await vscode.window.showQuickPick(items, { placeHolder: `Safety profile: ${current.profile}` });
	if (!picked) {
		return;
	}

	if (picked.action === 'profile' && picked.profile) {
		await applyProfile(picked.profile);
	} else if (picked.action === 'terminal') {
		await changeTerminal(current.permissions);
	} else if (picked.action === 'write') {
		await changeWritePrompt(current.permissions);
	}
}

async function applyProfile(profile: ProfileId): Promise<void> {
	if (profile === 'autonomous' && !(await confirmRisk(
		'Enable autonomous mode? The agent can run terminal commands and write outside the workspace without asking.',
		'the agent can run terminal commands and write outside the workspace without asking'
	))) {
		return;
	}
	const permissions = permissionsForProfile(profile);
	await writeDefaults({ permissions, profile });
	void vscode.window.showInformationMessage(`Quasi: safety profile set to ${profile}.`);
}

async function changeTerminal(current: SafetyPermissions): Promise<void> {
	const choices: Array<vscode.QuickPickItem & { value: TerminalPermission }> = [
		{ label: 'always', description: 'Prompt before every terminal command', value: 'always' },
		{ label: 'unlisted', description: 'Run allowlisted commands without asking; everything else prompts (no allowlist yet, so this prompts)', value: 'unlisted' },
		{ label: 'never', description: 'Run terminal commands without asking', value: 'never' }
	];
	const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Ask before terminal commands' });
	if (!picked) {
		return;
	}
	if (picked.value === 'never' && current.askBeforeTerminal !== 'never') {
		if (!(await confirmRisk(
			'Turn off asking before terminal commands? The agent can run terminal commands without asking.',
			'the agent can run terminal commands without asking'
		))) {
			return;
		}
	}
	await savePermissions({ ...current, askBeforeTerminal: picked.value });
}

async function changeWritePrompt(current: SafetyPermissions): Promise<void> {
	const next = !current.askBeforeWriteOutsideWorkspace;
	if (!next) {
		const confirmed = await vscode.window.showWarningMessage(
			'Turn off asking before writing outside the workspace? The agent can create or modify files outside the workspace without asking.',
			{
				modal: true,
				detail: 'This applies only to this device.'
			},
			'Cancel',
			'Turn off'
		);
		if (confirmed !== 'Turn off') {
			return;
		}
	}
	await savePermissions({ ...current, askBeforeWriteOutsideWorkspace: next });
}

async function savePermissions(permissions: SafetyPermissions): Promise<void> {
	const profile = profileForPermissions(permissions);
	await writeDefaults({ permissions, profile });
	void vscode.window.showInformationMessage(`Quasi: safety profile set to ${profile}.`);
}

async function confirmRisk(message: string, detail: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		message,
		{
			modal: true,
			detail: `${detail.charAt(0).toUpperCase()}${detail.slice(1)}. A malicious file or web page the agent reads could trigger commands. This applies only to this device.`
		},
		'Cancel',
		'Enable anyway'
	);
	return choice === 'Enable anyway';
}
