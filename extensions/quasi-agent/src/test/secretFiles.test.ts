/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isSensitivePath } from '../core/tools/secretFiles';

describe('isSensitivePath', () => {
	it('matches env and key files', () => {
		assert.strictEqual(isSensitivePath('.env'), true);
		assert.strictEqual(isSensitivePath('.env.local'), true);
		assert.strictEqual(isSensitivePath('src/.env.production'), true);
		assert.strictEqual(isSensitivePath('certs/server.pem'), true);
		assert.strictEqual(isSensitivePath('deploy/private.key'), true);
		assert.strictEqual(isSensitivePath('id_rsa'), true);
		assert.strictEqual(isSensitivePath('.ssh/id_ed25519.pub'), true);
	});

	it('matches credential stores', () => {
		assert.strictEqual(isSensitivePath('.npmrc'), true);
		assert.strictEqual(isSensitivePath('.netrc'), true);
		assert.strictEqual(isSensitivePath('.git/config'), true);
		assert.strictEqual(isSensitivePath('.docker/config.json'), true);
		assert.strictEqual(isSensitivePath('.kube/config'), true);
		assert.strictEqual(isSensitivePath('kubeconfig'), true);
		assert.strictEqual(isSensitivePath('dev.kubeconfig'), true);
		assert.strictEqual(isSensitivePath('.aws/credentials'), true);
		assert.strictEqual(isSensitivePath('.aws/config'), true);
		assert.strictEqual(isSensitivePath('.config/gcloud/credentials.json'), true);
	});

	it('does not match ordinary files', () => {
		assert.strictEqual(isSensitivePath('README.md'), false);
		assert.strictEqual(isSensitivePath('src/index.ts'), false);
		assert.strictEqual(isSensitivePath('config/settings.json'), false);
		assert.strictEqual(isSensitivePath('credentials.md'), false);
	});
});
