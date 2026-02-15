import { useState } from 'react'

export interface UserInfo {
	did: string
	handle: string
	isSupporter: boolean
}

export function useUserInfo() {
	const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
	const [loading, setLoading] = useState(true)
	const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)

	const fetchUserInfo = async () => {
		try {
			const response = await fetch('/api/user/info')
			if (!response.ok) {
				// Not authenticated or other error
				setIsAuthenticated(false)
				setUserInfo(null)
				return
			}
			const data = await response.json()
			setUserInfo(data)
			setIsAuthenticated(true)
		} catch (err) {
			console.error('Failed to fetch user info:', err)
			setIsAuthenticated(false)
		} finally {
			setLoading(false)
		}
	}

	return {
		userInfo,
		loading,
		isAuthenticated,
		fetchUserInfo
	}
}
