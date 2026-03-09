import { useState } from 'react'

export interface WebhookRecord {
	rkey: string
	scopeAturi: string
	url: string
	backlinks: boolean
	events: string[]
	enabled: boolean
	createdAt: string
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

	const fetchWebhooks = async () => {
		setWebhooksLoading(true)
		try {
			const res = await fetch('/api/webhook', { credentials: 'include' })
			if (!res.ok) throw new Error('Failed to fetch webhooks')
			const data = await res.json()
			if (data.success && data.records) {
				setWebhooks(data.records.map((r: any) => ({
					rkey: r.uri.split('/').pop(),
					scopeAturi: r.value?.scope?.aturi ?? '',
					url: r.value?.url ?? '',
					backlinks: r.value?.scope?.backlinks ?? false,
					events: r.value?.events ?? [],
					enabled: r.value?.enabled ?? true,
					createdAt: r.value?.createdAt ?? '',
				})))
			}
		} catch (err) {
			console.error('Failed to fetch webhooks:', err)
		} finally {
			setWebhooksLoading(false)
		}
	}

	const createWebhook = async (data: {
		scopeAturi: string
		url: string
		backlinks: boolean
		events: string[]
		secret: string
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
	}

	const deleteWebhook = async (rkey: string) => {
		const res = await fetch(`/api/webhook/${rkey}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const result = await res.json()
		if (!res.ok || !result.success) throw new Error(result.error || 'Failed to delete webhook')
		setWebhooks(prev => prev.filter(w => w.rkey !== rkey))
	}

	/** Fetch the last 100 webhook delivery events for this user from Redis. */
	const fetchEventLogs = async () => {
		setEventLogsLoading(true)
		try {
			const res = await fetch('/api/webhook/events', { credentials: 'include' })
			if (!res.ok) throw new Error('Failed to fetch events')
			const data = await res.json()
			if (data.success && data.events) setEventLogs(data.events)
		} catch (err) {
			console.error('Failed to fetch event logs:', err)
		} finally {
			setEventLogsLoading(false)
		}
	}

	return {
		webhooks, webhooksLoading, fetchWebhooks,
		eventLogs, eventLogsLoading, fetchEventLogs,
		isCreating, createWebhook, deleteWebhook,
	}
}
