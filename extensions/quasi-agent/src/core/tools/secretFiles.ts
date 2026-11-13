/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SENSITIVE_BASENAMES: ReadonlyArray<RegExp> = [
	/^\.env(\..*)?$/,
	/^\.npmrc$/,
	/^\.netrc$/,
	/^\.pgpass$/,
	/^\.htpasswd$/,
	/^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
	/\.(pem|key|p12|pfx)$/,
	/kubeconfig/
];

const SENSITIVE_PATH_FRAGMENTS: ReadonlyArray<string> = [
	'.aws/credentials',
	'.aws/config',
	'.docker/config.json',
	'.git/config',
	'.kube/config',
	'.azure/',
	'.config/gcloud/'
];

/**
 * Whether a workspace-relative path looks like it may contain credentials.
 * Reading such a file (or searching it) requires approval because its contents
 * would be sent to the model provider.
 */
export function isSensitivePath(relativePath: string): boolean {
	const path = relativePath.replace(/\\/g, '/').toLowerCase();
	const basename = path.split('/').pop() ?? '';
	for (const pattern of SENSITIVE_BASENAMES) {
		if (pattern.test(basename)) {
			return true;
		}
	}
	for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
		if (path.includes(fragment)) {
			return true;
		}
	}
	return false;
}
