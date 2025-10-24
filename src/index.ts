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
import { authRoutes } from './routes/auth'
import { wispRoutes } from './routes/wisp'
import { domainRoutes } from './routes/domain'
import { userRoutes } from './routes/user'

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
	.use(authRoutes(client))
	.use(wispRoutes(client))
	.use(domainRoutes(client))
	.use(userRoutes(client))
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
