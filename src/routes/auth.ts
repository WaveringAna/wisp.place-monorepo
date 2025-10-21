import { Elysia } from 'elysia'
import { NodeOAuthClient } from '@atproto/oauth-client-node'

export const authRoutes = (client: NodeOAuthClient) => new Elysia()
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

		return c.redirect('/editor')
	})