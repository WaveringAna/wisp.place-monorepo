// Quick script to create admin user with randomly generated password
import { adminAuth } from '../src/lib/admin-auth'
import { randomBytes } from 'crypto'

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

const username = 'admin'
const password = generatePassword(20)

await adminAuth.init()
await adminAuth.createAdmin(username, password)

console.log('\n╔════════════════════════════════════════════════════════════════╗')
console.log('║              ADMIN USER CREATED SUCCESSFULLY                   ║')
console.log('╚════════════════════════════════════════════════════════════════╝\n')
console.log(`Username: ${username}`)
console.log(`Password: ${password}`)
console.log('\n⚠️  IMPORTANT: Save this password securely!')
console.log('This password will not be shown again.\n')
console.log('Change it with: bun run change-admin-password.ts admin NEW_PASSWORD\n')

process.exit(0)
