// Signs gatus custom alerts for an albedo webhook (HMAC-SHA256 of the raw body) and forwards them.
import { createHmac } from 'node:crypto'

const target = Bun.env.ALBEDO_WEBHOOK_URL
const secret = Bun.env.ALBEDO_WEBHOOK_SECRET
if (!target || !secret) throw new Error('ALBEDO_WEBHOOK_URL and ALBEDO_WEBHOOK_SECRET are required')

const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

Bun.serve({
	hostname: '127.0.0.1',
	port: 8091,
	async fetch(request) {
		if (request.method !== 'POST') return new Response(null, { status: 405 })
		const body = await request.text()
		const forwarded = await fetch(target, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-albedo-signature': sign(body) },
			body,
		}).catch((error: unknown) => {
			console.error('forward failed', error)
			return new Response(null, { status: 502 })
		})
		console.log('forwarded', forwarded.status)
		return new Response(null, { status: forwarded.status })
	},
})
