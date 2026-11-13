/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Capabilities } from './types';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface CapabilityAssessment {
	readonly tools: CapabilityState;
	readonly vision: CapabilityState;
	readonly contextLength?: number;
}

function toState(value: boolean | undefined): CapabilityState {
	return value === undefined ? 'unknown' : value ? 'supported' : 'unsupported';
}

/**
 * Assess capabilities from what the server reported and any per-provider
 * manual override. The override wins. Missing information is `unknown` (not
 * assumed unsupported), so callers can avoid false warnings.
 */
export function assessCapabilities(reported: Partial<Capabilities> | undefined, override: Partial<Capabilities> | undefined): CapabilityAssessment {
	return {
		tools: toState(override?.tools ?? reported?.tools),
		vision: toState(override?.vision ?? reported?.vision),
		contextLength: override?.contextLength ?? reported?.contextLength,
	};
}

/**
 * Conservative capabilities for fallback logic (e.g. Phase 2 degrading to
 * plain chat): anything not known to be supported is treated as unsupported.
 */
export function effectiveCapabilities(assessment: CapabilityAssessment): Capabilities {
	return {
		tools: assessment.tools === 'supported',
		vision: assessment.vision === 'supported',
		streaming: true,
		contextLength: assessment.contextLength,
	};
}
