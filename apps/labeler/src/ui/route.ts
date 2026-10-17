import type { QueueView } from '../moderation/types'

export type Route =
	| { kind: 'queue'; view: QueueView }
	| { kind: 'search'; q: string }
	| { kind: 'activity' }
	| { kind: 'account'; did: string }

const QUEUE_VIEWS: readonly string[] = ['flagged', 'pending', 'recent', 'reviewed']

/** Reads `location.hash`: #/flagged, #/search?q=..., #/activity, #/account/<did>. */
export function parseRoute(hash: string): Route {
	const path = hash.replace(/^#\/?/, '')
	const [head = '', query = ''] = path.split('?', 2)
	if (QUEUE_VIEWS.includes(head)) return { kind: 'queue', view: head as QueueView }
	if (head === 'search') return { kind: 'search', q: new URLSearchParams(query).get('q') ?? '' }
	if (head === 'activity') return { kind: 'activity' }
	if (head.startsWith('account/')) {
		const did = decodeURIComponent(head.slice('account/'.length))
		if (did) return { kind: 'account', did }
	}
	return { kind: 'queue', view: 'flagged' }
}

export function formatRoute(route: Route): string {
	switch (route.kind) {
		case 'queue':
			return `#/${route.view}`
		case 'search':
			return route.q ? `#/search?${new URLSearchParams({ q: route.q })}` : '#/search'
		case 'activity':
			return '#/activity'
		case 'account':
			return `#/account/${encodeURIComponent(route.did)}`
	}
}
