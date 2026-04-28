import { useCallback, useState } from 'react'

export interface SecretMeta {
	name: string
	createdAt: string
	lastRotatedAt?: string
}

export function useSecretData() {
	const [secrets, setSecrets] = useState<SecretMeta[]>([])
	const [secretsLoading, setSecretsLoading] = useState(false)
	const [isCreatingSecret, setIsCreatingSecret] = useState(false)

	const fetchSecrets = useCallback(async () => {
		setSecretsLoading(true)
		try {
			const res = await fetch('/api/secret', { credentials: 'include' })
			if (!res.ok) throw new Error('Failed to fetch secrets')
			const data = await res.json()
			setSecrets(data.secrets ?? [])
		} catch (err) {
			console.error('Failed to fetch secrets:', err)
		} finally {
			setSecretsLoading(false)
		}
	}, [])

	const createSecret = useCallback(
		async (name: string): Promise<{ token: string }> => {
			setIsCreatingSecret(true)
			try {
				const res = await fetch('/api/secret', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({ name }),
				})
				const data = await res.json()
				if (!res.ok) throw new Error(data.error || 'Failed to create secret')
				await fetchSecrets()
				return { token: data.token }
			} finally {
				setIsCreatingSecret(false)
			}
		},
		[fetchSecrets],
	)

	const deleteSecret = useCallback(async (name: string): Promise<void> => {
		const res = await fetch(`/api/secret/${encodeURIComponent(name)}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		if (!res.ok) {
			const data = await res.json().catch(() => ({}))
			throw new Error(data.error || 'Failed to delete secret')
		}
		setSecrets((prev) => prev.filter((s) => s.name !== name))
	}, [])

	const rotateSecret = useCallback(async (name: string): Promise<{ token: string }> => {
		const res = await fetch(`/api/secret/${encodeURIComponent(name)}/rotate`, {
			method: 'POST',
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || 'Failed to rotate secret')
		setSecrets((prev) => prev.map((s) => (s.name === name ? { ...s, lastRotatedAt: data.rotatedAt } : s)))
		return { token: data.token }
	}, [])

	return {
		secrets,
		secretsLoading,
		isCreatingSecret,
		fetchSecrets,
		createSecret,
		deleteSecret,
		rotateSecret,
	}
}
