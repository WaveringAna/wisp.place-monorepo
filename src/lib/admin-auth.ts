// Admin authentication system
import { db } from './db'
import { randomBytes, createHash } from 'crypto'

interface AdminUser {
	id: number
	username: string
	password_hash: string
	created_at: Date
}

interface AdminSession {
	sessionId: string
	username: string
	expiresAt: Date
}

// In-memory session storage
const sessions = new Map<string, AdminSession>()
const SESSION_DURATION = 24 * 60 * 60 * 1000 // 24 hours

// Hash password using SHA-256 with salt
function hashPassword(password: string, salt: string): string {
	return createHash('sha256').update(password + salt).digest('hex')
}

// Generate random salt
function generateSalt(): string {
	return randomBytes(32).toString('hex')
}

// Generate session ID
function generateSessionId(): string {
	return randomBytes(32).toString('hex')
}

// Generate a secure random password
function generatePassword(length: number = 20): string {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
	const bytes = randomBytes(length)
	let password = ''
	for (let i = 0; i < length; i++) {
		password += chars[bytes[i] % chars.length]
	}
	return password
}

export const adminAuth = {
	// Initialize admin table
	async init() {
		await db`
			CREATE TABLE IF NOT EXISTS admin_users (
				id SERIAL PRIMARY KEY,
				username TEXT UNIQUE NOT NULL,
				password_hash TEXT NOT NULL,
				salt TEXT NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`
	},

	// Check if any admin exists
	async hasAdmin(): Promise<boolean> {
		const result = await db`SELECT COUNT(*) as count FROM admin_users`
		return result[0].count > 0
	},

	// Create admin user
	async createAdmin(username: string, password: string): Promise<boolean> {
		try {
			const salt = generateSalt()
			const passwordHash = hashPassword(password, salt)

			await db`INSERT INTO admin_users (username, password_hash, salt) VALUES (${username}, ${passwordHash}, ${salt})`

			console.log(`✓ Admin user '${username}' created successfully`)
			return true
		} catch (error) {
			console.error('Failed to create admin user:', error)
			return false
		}
	},

	// Verify admin credentials
	async verify(username: string, password: string): Promise<boolean> {
		try {
			const result = await db`SELECT password_hash, salt FROM admin_users WHERE username = ${username}`

			if (result.length === 0) {
				return false
			}

			const { password_hash, salt } = result[0]
			const hash = hashPassword(password, salt as string)
			return hash === password_hash
		} catch (error) {
			console.error('Failed to verify admin:', error)
			return false
		}
	},

	// Create session
	createSession(username: string): string {
		const sessionId = generateSessionId()
		const expiresAt = new Date(Date.now() + SESSION_DURATION)

		sessions.set(sessionId, {
			sessionId,
			username,
			expiresAt
		})

		// Clean up expired sessions
		this.cleanupSessions()

		return sessionId
	},

	// Verify session
	verifySession(sessionId: string): AdminSession | null {
		const session = sessions.get(sessionId)

		if (!session) {
			return null
		}

		if (session.expiresAt.getTime() < Date.now()) {
			sessions.delete(sessionId)
			return null
		}

		return session
	},

	// Delete session
	deleteSession(sessionId: string) {
		sessions.delete(sessionId)
	},

	// Cleanup expired sessions
	cleanupSessions() {
		const now = Date.now()
		for (const [sessionId, session] of sessions.entries()) {
			if (session.expiresAt.getTime() < now) {
				sessions.delete(sessionId)
			}
		}
	}
}

// Prompt for admin creation on startup
export async function promptAdminSetup() {
	await adminAuth.init()

	const hasAdmin = await adminAuth.hasAdmin()
	if (hasAdmin) {
		return
	}

	// Skip prompt if SKIP_ADMIN_SETUP is set
	if (process.env.SKIP_ADMIN_SETUP === 'true') {
		console.log('\n╔════════════════════════════════════════════════════════════════╗')
		console.log('║                    ADMIN SETUP REQUIRED                        ║')
		console.log('╚════════════════════════════════════════════════════════════════╝\n')
		console.log('No admin user found.')
		console.log('Create one with: bun run create-admin.ts\n')
		return
	}

	console.log('\n===========================================')
	console.log('  ADMIN SETUP REQUIRED')
	console.log('===========================================\n')
	console.log('No admin user found. Creating one automatically...\n')

	// Auto-generate admin credentials with random password
	const username = 'admin'
	const password = generatePassword(20)

	await adminAuth.createAdmin(username, password)

	console.log('╔════════════════════════════════════════════════════════════════╗')
	console.log('║              ADMIN USER CREATED SUCCESSFULLY                   ║')
	console.log('╚════════════════════════════════════════════════════════════════╝\n')
	console.log(`Username: ${username}`)
	console.log(`Password: ${password}`)
	console.log('\n⚠️  IMPORTANT: Save this password securely!')
	console.log('This password will not be shown again.\n')
	console.log('Change it with: bun run change-admin-password.ts admin NEW_PASSWORD\n')
}

// Elysia middleware to protect admin routes
export function requireAdmin({ cookie, set }: any) {
	const sessionId = cookie.admin_session?.value

	if (!sessionId) {
		set.status = 401
		return { error: 'Unauthorized' }
	}

	const session = adminAuth.verifySession(sessionId)
	if (!session) {
		set.status = 401
		return { error: 'Unauthorized' }
	}

	// Session is valid, continue
	return
}
