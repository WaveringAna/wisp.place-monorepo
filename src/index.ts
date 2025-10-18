import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'
import { openapi, fromTypes } from '@elysiajs/openapi'

import type { Config } from './lib/types'
import { BASE_HOST } from './lib/constants'
import {
	createClientMetadata,
	getOAuthClient,
	getCurrentKeys
} from './lib/oauth-client'

const config: Config = {
	domain: (Bun.env.DOMAIN ?? `https://${BASE_HOST}`) as `https://${string}`,
	clientName: Bun.env.CLIENT_NAME ?? 'PDS-View'
}

const client = await getOAuthClient(config)

export const app = new Elysia()
	.use(
		openapi({
			references: fromTypes()
		})
	)
	.use(
		await staticPlugin({
			prefix: '/'
		})
	)
	.post('/api/auth/signin', async (c) => {
		try {
			const { handle } = await c.request.json()
			const state = crypto.randomUUID()
			const url = await client.authorize(handle, { state })
			return { url: url.toString() }
		} catch (err) {
			console.error('Signin error', err)
			return  { error: 'Authentication failed' }
		}
	})
	.get('/api/auth/callback', async (c) => {
		const params = new URLSearchParams(c.query)
		const { session } = await client.callback(params)
		if (!session) return { error: 'Authentication failed' }

		const cookieSession = c.cookie
		cookieSession.did.value = session.did

		return c.redirect('/')
	})
	.get('/client-metadata.json', (c) => {
		return createClientMetadata(config)
	})
	.get('/jwks.json', (c) => {
		const keys = getCurrentKeys()
		if (!keys.length) return { keys: [] }

		return {
			keys: keys.map((k) => {
				const jwk = k.publicJwk ?? k
				const { ...pub } = jwk
				return pub
			})
		}
	})
	.use(cors())
	.listen(8000)

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
)
