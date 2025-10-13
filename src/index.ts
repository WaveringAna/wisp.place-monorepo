import { Elysia } from 'elysia'
import { staticPlugin } from '@elysiajs/static'
import { openapi, fromTypes } from '@elysiajs/openapi'

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
	.get('/message', { message: 'Hello from server' } as const)
	.listen(3000)

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
)
