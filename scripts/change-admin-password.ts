// Change admin password
import { adminAuth } from '../src/lib/admin-auth'
import { db } from '../src/lib/db'
import { randomBytes, createHash } from 'crypto'

// Get username and new password from command line
const username = process.argv[2]
const newPassword = process.argv[3]

if (!username || !newPassword) {
	console.error('Usage: bun run change-admin-password.ts <username> <new-password>')
	process.exit(1)
}

if (newPassword.length < 8) {
	console.error('Password must be at least 8 characters')
	process.exit(1)
}

// Hash password
function hashPassword(password: string, salt: string): string {
	return createHash('sha256').update(password + salt).digest('hex')
}

function generateSalt(): string {
	return randomBytes(32).toString('hex')
}

// Initialize
await adminAuth.init()

// Check if user exists
const result = await db`SELECT username FROM admin_users WHERE username = ${username}`
if (result.length === 0) {
	console.error(`Admin user '${username}' not found`)
	process.exit(1)
}

// Update password
const salt = generateSalt()
const passwordHash = hashPassword(newPassword, salt)

await db`UPDATE admin_users SET password_hash = ${passwordHash}, salt = ${salt} WHERE username = ${username}`

console.log(`✓ Password updated for admin user '${username}'`)
process.exit(0)
