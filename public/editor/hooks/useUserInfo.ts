import { useState } from 'react'

export interface UserInfo {
	did: string
	handle: string
}

export function useUserInfo() {
	const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
	const [loading, setLoading] = useState(true)

	const fetchUserInfo = async () => {
		try {
			const response = await fetch('/api/user/info')
			const data = await response.json()
			setUserInfo(data)
		} catch (err) {
			console.error('Failed to fetch user info:', err)
		} finally {
			setLoading(false)
		}
	}

	return {
		userInfo,
		loading,
		fetchUserInfo
	}
}
