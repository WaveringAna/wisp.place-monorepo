import type { Agent } from '@atproto/api'
import { cancel, isCancel, text } from '@clack/prompts'
import type { Command } from 'commander'
import { authenticate, resolveAccountForCwd } from './auth.ts'
import { createSpinner, pc, type SpinnerLike } from './progress.ts'
import { parseServiceDid } from './wisp-service.ts'

export interface XrpcCommandOptions {
	password?: string
	db?: string
	service?: string
	json?: boolean
}

export function withExit(handler: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<never> {
	return async (...args: any[]): Promise<never> => {
		try {
			await handler(...args)
			process.exit(0)
		} catch (err: any) {
			console.error(pc.red(`\nError: ${err.message}\n`))
			process.exit(1)
		}
	}
}

export function addXrpcAuthOptions<T extends Command>(command: T): T {
	return command
		.option('--password <password>', 'App password for headless authentication')
		.option('--db <path>', 'Account database path')
		.option('--service <did:...>', 'Service DID to proxy through')
		.option('--json', 'Output raw JSON')
}

const OAUTH_FALLBACK_PREFIX = 'If browser does not open, visit: '
const MAX_SPINNER_TEXT_LENGTH = 120
const APP_PASSWORD_PATTERN = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i

function truncateSpinnerText(message: string): string {
	const compact = message.replace(/\s+/g, ' ').trim()
	if (compact.length <= MAX_SPINNER_TEXT_LENGTH) {
		return compact
	}
	return `${compact.slice(0, MAX_SPINNER_TEXT_LENGTH - 1)}...`
}

export function bindAuthStatusToSpinner(spinner: SpinnerLike): (message: string) => void {
	return (message: string) => {
		if (message.startsWith(OAUTH_FALLBACK_PREFIX)) {
			spinner.text = 'Waiting for OAuth callback...'
			// Print long OAuth URL once outside the spinner line.
			console.log(`\n${message}\n`)
			return
		}

		spinner.text = truncateSpinnerText(message)
	}
}

function looksLikeHandle(value: string): boolean {
	return value.includes('.') && /^[a-z0-9._:-]+$/i.test(value)
}

function looksLikeAppPassword(value: string): boolean {
	return APP_PASSWORD_PATTERN.test(value)
}

export async function resolveIdentifier(
	identifier: string | undefined,
	cancelMessage = 'Command cancelled',
): Promise<string> {
	if (identifier) {
		return identifier
	}

	const result = await text({
		message: 'AT Protocol handle',
		placeholder: 'alice.bsky.social',
		validate: (value) => {
			if (!value) {
				return 'Handle is required'
			}

			if (!value.includes('.')) {
				return 'Handle must include a domain (e.g., alice.bsky.social)'
			}
		},
	})

	if (isCancel(result)) {
		cancel(cancelMessage)
		process.exit(0)
	}

	return result
}

export async function authenticateForXrpc(
	identifier: string | undefined,
	options: XrpcCommandOptions,
): Promise<{ agent: Agent; serviceDid: string; did: string }> {
	if (!identifier && options.password && looksLikeHandle(options.password) && !looksLikeAppPassword(options.password)) {
		throw new Error(
			'`--password` appears to have consumed the handle argument. Provide a password value and pass the handle separately.',
		)
	}

	// Skip the handle prompt if a stored account already applies here
	const knownAccount = identifier || options.password ? undefined : await resolveAccountForCwd(options.db)
	const resolvedIdentifier = identifier ?? (knownAccount ? undefined : await resolveIdentifier(undefined))
	const serviceDid = parseServiceDid(options.service)

	const spinner = createSpinner('Authenticating...').start()
	const { agent, did } = await authenticate(resolvedIdentifier, {
		appPassword: options.password,
		dbPath: options.db,
		onStatus: bindAuthStatusToSpinner(spinner),
	})
	spinner.succeed(`Authenticated as ${resolvedIdentifier ?? knownAccount?.handle ?? did}`)

	return { agent, serviceDid, did }
}
