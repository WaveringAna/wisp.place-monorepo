import type { APIRoute } from 'astro'
import { standardPublicationUri } from '../../standard'

/** Confirms that blog.wisp.place is owned by this Standard.site publication. */
export const GET: APIRoute = () =>
	new Response(standardPublicationUri, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	})
