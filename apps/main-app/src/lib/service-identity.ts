import { P256PrivateKeyExportable } from '@atcute/crypto'

import { createLogger } from '@wispplace/observability'

import { getServiceIdentityKeypair, setServiceIdentityKeypair } from './db'

const logger = createLogger('main-app')

const validateMultikey = (value: string): string => {
	const trimmed = value.trim()
	if (!trimmed.startsWith('z')) {
		throw new Error('service key must be a multibase base58btc key')
	}

	return trimmed
}

export interface ServiceIdentityKeypair {
	publicKeyMultibase: string
	privateKeyMultibase: string
}

const generateAndPersistKeypair = async (): Promise<ServiceIdentityKeypair> => {
	const keypair = await P256PrivateKeyExportable.createKeypair()
	const publicKeyMultibase = validateMultikey(await keypair.exportPublicKey('multikey'))
	const privateKeyMultibase = validateMultikey(await keypair.exportPrivateKey('multikey'))

	await setServiceIdentityKeypair(publicKeyMultibase, privateKeyMultibase)
	logger.info('Generated new service identity keypair')

	return {
		publicKeyMultibase,
		privateKeyMultibase,
	}
}

export const ensureServiceIdentityKeypair = async (
	configuredPublic?: string | null,
	configuredPrivate?: string | null,
): Promise<ServiceIdentityKeypair> => {
	const explicitPublic = configuredPublic ? validateMultikey(configuredPublic) : null
	const explicitPrivate = configuredPrivate ? validateMultikey(configuredPrivate) : null

	if ((explicitPublic && !explicitPrivate) || (!explicitPublic && explicitPrivate)) {
		throw new Error('both SERVICE_PUBLIC_KEY_MULTIBASE and SERVICE_PRIVATE_KEY_MULTIBASE must be set together')
	}

	if (explicitPublic && explicitPrivate) {
		await setServiceIdentityKeypair(explicitPublic, explicitPrivate)
		logger.info('Updated service identity keypair from environment')

		return {
			publicKeyMultibase: explicitPublic,
			privateKeyMultibase: explicitPrivate,
		}
	}

	const existing = await getServiceIdentityKeypair()
	if (!existing) {
		return generateAndPersistKeypair()
	}

	if (!existing.privateKeyMultibase) {
		logger.warn('Service identity record missing private key; generating replacement keypair')
		return generateAndPersistKeypair()
	}

	return {
		publicKeyMultibase: existing.publicKeyMultibase,
		privateKeyMultibase: existing.privateKeyMultibase,
	}
}
