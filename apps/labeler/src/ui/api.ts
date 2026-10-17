import type {
	AccountView,
	ActiveLabel,
	LabelRequest,
	Me,
	ModerationEvent,
	QueueResponse,
	QueueView,
	SiteSummary,
	VerdictRequest,
} from '../moderation/types'

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

export type Api = ReturnType<typeof createApi>

/**
 * The moderation API over `fetchFn`. Any 401 calls `onUnauthorized` (the app sends
 * the browser to /login) and still rejects, so callers never treat it as data.
 */
export function createApi(fetchFn: typeof fetch, onUnauthorized: () => void) {
	async function call<T>(path: string, init?: RequestInit): Promise<T> {
		let res: Response
		try {
			res = await fetchFn(path, { credentials: 'same-origin', ...init })
		} catch {
			throw new ApiFailure(0, 'network error')
		}
		if (res.status === 401) {
			onUnauthorized()
			throw new ApiFailure(401, 'signed out')
		}
		if (!res.ok) {
			let message = `HTTP ${res.status}`
			try {
				const body = (await res.json()) as { error?: unknown }
				if (typeof body.error === 'string') message = body.error
			} catch {}
			throw new ApiFailure(res.status, message)
		}
		return (await res.json()) as T
	}

	function post<T>(path: string, body: unknown): Promise<T> {
		return call<T>(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
	}

	function query(params: Record<string, string | number | null | undefined>): string {
		const search = new URLSearchParams()
		for (const [key, value] of Object.entries(params)) {
			if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
		}
		const text = search.toString()
		return text ? `?${text}` : ''
	}

	return {
		me: () => call<Me>('/api/me'),
		queue: (view: QueueView, cursor: string | null, limit: number) =>
			call<QueueResponse>(`/api/queue${query({ view, cursor, limit })}`),
		account: (did: string) => call<AccountView>(`/api/account/${encodeURIComponent(did)}`),
		search: (q: string) => call<{ items: SiteSummary[] }>(`/api/search${query({ q })}`),
		events: (cursor: string | null) =>
			call<{ items: ModerationEvent[]; cursor: string | null }>(`/api/events${query({ cursor })}`),
		verdict: (request: VerdictRequest) => post<{ site: SiteSummary | null }>('/api/verdict', request),
		label: (request: LabelRequest) => post<{ labels: ActiveLabel[] }>('/api/label', request),
	}
}
