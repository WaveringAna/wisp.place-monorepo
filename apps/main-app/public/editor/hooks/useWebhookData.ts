import { useCallback, useState } from 'react'

export interface WebhookRecord {
	rkey: string
	scopeAturi: string
	url: string
	backlinks: boolean
	events: string[]
	enabled: boolean
	createdAt: string
	secretId?: string
}

export interface WebhookEventLog {
	ownerDid: string
	rkey: string
	url: string
	eventKind: string
	eventDid: string
	eventCollection: string
	eventRkey: string
	cid?: string
	deliveredAt: string
	status: 'ok' | 'failed'
}

export function useWebhookData() {
	const [webhooks, setWebhooks] = useState<WebhookRecord[]>([])
	const [webhooksLoading, setWebhooksLoading] = useState(false)
	const [eventLogs, setEventLogs] = useState<WebhookEventLog[]>([])
	const [eventLogsLoading, setEventLogsLoading] = useState(false)
	const [isCreating, setIsCreating] = useState(false)

	const fetchWebhooks = useCallback(async () => {
		setWebhooksLoading(true)
		try {
			const res = await fetch('/api/webhook', { credentials: 'include' })
			if (!res.ok) throw new Error('Failed to fetch webhooks')
			const data = await res.json()
			if (data.success && data.records) {
				setWebhooks(
					data.records.map((r: { uri: string; value?: Record<string, unknown> }) => {
						const scope = r.value?.scope as Record<string, unknown> | undefined
						return {
							rkey: r.uri.split('/').pop() ?? '',
							scopeAturi: (scope?.aturi as string) ?? '',
							url: (r.value?.url as string) ?? '',
							backlinks: (scope?.backlinks as boolean) ?? false,
							events: (r.value?.events as string[]) ?? [],
							enabled: (r.value?.enabled as boolean) ?? true,
							createdAt: (r.value?.createdAt as string) ?? '',
							secretId: r.value?.secretId as string | undefined,
						}
					}),
				)
			}
		} catch {
			console.error('Failed to fetch webhooks')
		} finally {
			setWebhooksLoading(false)
		}
	}, [])

	const fetchEventLogs = useCallback(async () => {
		setEventLogsLoading(true)
		try {
			const res = await fetch('/api/webhook/events', { credentials: 'include' })
			if (!res.ok) throw new Error('Failed to fetch events')
			const data = await res.json()
			if (data.success && data.events) setEventLogs(data.events)
		} catch {
			console.error('Failed to fetch event logs')
		} finally {
			setEventLogsLoading(false)
		}
	}, [])

	const createWebhook = useCallback(
		async (data: {
			scopeAturi: string
			url: string
			backlinks: boolean
			events: string[]
			secret?: string
			secretId?: string
			enabled: boolean
		}) => {
			setIsCreating(true)
			try {
				const res = await fetch('/api/webhook', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify(data),
				})
				const result = await res.json()
				if (!res.ok || !result.success) throw new Error(result.error || 'Failed to create webhook')
				await fetchWebhooks()
				return result
			} finally {
				setIsCreating(false)
			}
		},
		[fetchWebhooks],
	)

	const deleteWebhook = useCallback(async (rkey: string) => {
		const res = await fetch(`/api/webhook/${rkey}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const result = await res.json()
		if (!res.ok || !result.success) throw new Error(result.error || 'Failed to delete webhook')
		setWebhooks((prev) => prev.filter((w) => w.rkey !== rkey))
	}, [])

	return {
		webhooks,
		webhooksLoading,
		fetchWebhooks,
		eventLogs,
		eventLogsLoading,
		fetchEventLogs,
		isCreating,
		createWebhook,
		deleteWebhook,
	}
}
