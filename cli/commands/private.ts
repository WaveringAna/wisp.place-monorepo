import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Agent } from '@atproto/api'
import { MAX_PRIVATE_SITE_FILE_COUNT, MAX_PRIVATE_SITE_SIZE } from '@wispplace/constants'
import type { OutputSchema as PrivateCreateOutput } from '@wispplace/lexicons/types/place/wisp/v2/privateSite/create'
import type { OutputSchema as PrivateCreateShareOutput } from '@wispplace/lexicons/types/place/wisp/v2/privateSite/createShare'
import type { OutputSchema as PrivateListOutput } from '@wispplace/lexicons/types/place/wisp/v2/privateSite/list'
import type { OutputSchema as PrivateListSharesOutput } from '@wispplace/lexicons/types/place/wisp/v2/privateSite/listShares'
import { lookup } from 'mime-types'
import { authenticateForXrpc, type XrpcCommandOptions } from '../lib/command-utils.ts'
import { createSpinner, pc } from '../lib/progress.ts'
import { parseServiceDid, WISP_PROXY_SERVICE_ID } from '../lib/wisp-service.ts'
import { callWispXrpc } from '../lib/xrpc.ts'
import { collectFiles, createIgnoreMatcher } from './deploy.ts'

export interface PrivateDeployOptions extends XrpcCommandOptions {
	path: string
	name?: string
	/** Minutes until expiry. Omit for the server default; `0` for no expiry. */
	expiry?: string
}

export interface PrivateShareOptions extends XrpcCommandOptions {
	label?: string
	expiry?: string
}

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatExpiry = (expiresAt?: string): string => {
	if (!expiresAt) return pc.dim('never expires')
	const when = new Date(expiresAt)
	const mins = Math.round((when.getTime() - Date.now()) / 60000)
	if (mins <= 0) return pc.red('expired')
	if (mins < 60) return pc.yellow(`expires in ${mins}m`)
	if (mins < 60 * 24) return pc.yellow(`expires in ${Math.round(mins / 60)}h`)
	return pc.dim(`expires ${when.toISOString().slice(0, 10)}`)
}

const parseExpiry = (raw: string | undefined): number | undefined => {
	if (raw === undefined) return undefined
	const value = Number(raw)
	if (!Number.isInteger(value) || value < 0) {
		throw new Error('--expiry must be a non-negative whole number of minutes (0 disables expiry)')
	}
	return value
}

/**
 * Upload a directory as a private site.
 *
 * Private sites never touch the PDS, so this posts a multipart body to the wisp service
 * rather than uploading blobs and writing a `place.wisp.fs` record.
 */
export async function privateDeploy(agent: Agent, options: PrivateDeployOptions): Promise<PrivateCreateOutput> {
	const siteDir = resolve(options.path)
	if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
		throw new Error(`Not a directory: ${siteDir}`)
	}

	const name = (options.name || basename(siteDir)).trim()
	const expiryMinutes = parseExpiry(options.expiry)

	console.log(pc.cyan(`\nCreating private site ${pc.bold(name)} from ${siteDir}\n`))

	const spinner = createSpinner('Scanning directory...').start()
	const ig = createIgnoreMatcher(siteDir)
	const files = collectFiles(siteDir, ig, siteDir)

	if (files.length === 0) {
		spinner.fail('No files to upload')
		throw new Error('No files found to upload')
	}
	if (files.length > MAX_PRIVATE_SITE_FILE_COUNT) {
		spinner.fail('Too many files')
		throw new Error(`Private sites are limited to ${MAX_PRIVATE_SITE_FILE_COUNT} files (found ${files.length})`)
	}

	const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
	if (totalBytes > MAX_PRIVATE_SITE_SIZE) {
		spinner.fail('Site too large')
		throw new Error(
			`Private sites are limited to ${formatBytes(MAX_PRIVATE_SITE_SIZE)} (found ${formatBytes(totalBytes)})`,
		)
	}

	spinner.succeed(`Found ${files.length} files (${formatBytes(totalBytes)})`)

	const form = new FormData()
	form.append('name', name)
	if (expiryMinutes !== undefined) {
		form.append('expiryMinutes', String(expiryMinutes))
	}

	const uploadSpinner = createSpinner('Uploading privately...').start()
	for (const file of files) {
		const bytes = readFileSync(file.path)
		const mime = lookup(file.relativePath) || 'application/octet-stream'
		form.append('files', new File([new Uint8Array(bytes)], file.relativePath, { type: mime }), file.relativePath)
	}

	// The generated lexicon marks this input as a blob body, so the multipart FormData is
	// passed through as the raw request body rather than being JSON-encoded.
	const serviceDid = parseServiceDid(options.service)
	const proxied = agent.withProxy(WISP_PROXY_SERVICE_ID, serviceDid)
	const response = await proxied.call('place.wisp.v2.privateSite.create', undefined, form)
	const result = response.data as PrivateCreateOutput

	uploadSpinner.succeed('Uploaded')

	console.log()
	console.log(`${pc.bold('Private site:')} ${pc.cyan(result.url)}`)
	console.log(`${pc.dim('site id:')} ${result.siteId}`)
	console.log(`${pc.dim('files:')} ${result.fileCount}  ${pc.dim('size:')} ${formatBytes(result.totalBytes)}`)
	console.log(`${pc.dim('expiry:')} ${formatExpiry(result.expiresAt)}`)
	console.log()
	console.log(pc.dim('Only you can open that URL while signed in.'))
	console.log(pc.dim(`Create a shareable link with: wisp private share ${result.siteId}`))

	return result
}

export async function privateList(agent: Agent, options: XrpcCommandOptions): Promise<void> {
	const spinner = createSpinner('Fetching private sites...').start()
	const data = await callWispXrpc<PrivateListOutput>(agent, 'place.wisp.v2.privateSite.list', {
		serviceDid: options.service,
	})
	spinner.succeed('Fetched private sites')

	if (data.sites.length === 0) {
		console.log(pc.dim('No private sites found.'))
		return
	}

	console.log(pc.bold(`\nPrivate sites (${data.sites.length})`))
	for (const site of data.sites) {
		const header = site.expired ? pc.red(`${site.name} (expired)`) : pc.bold(site.name)
		console.log(`- ${header}`)
		console.log(`  ${pc.dim('id:')} ${site.siteId}`)
		console.log(
			`  ${pc.dim('files:')} ${site.fileCount}  ${pc.dim('size:')} ${formatBytes(site.totalBytes)}  ${formatExpiry(site.expiresAt)}`,
		)
		console.log(`  ${pc.dim('active share links:')} ${site.shareCount}`)
	}
}

export async function privateDelete(agent: Agent, siteId: string, options: XrpcCommandOptions): Promise<void> {
	const spinner = createSpinner('Deleting private site...').start()
	await callWispXrpc(agent, 'place.wisp.v2.privateSite.delete', {
		serviceDid: options.service,
		data: { siteId },
	})
	spinner.succeed(`Deleted private site ${siteId}`)
}

export async function privateShare(agent: Agent, siteId: string, options: PrivateShareOptions): Promise<void> {
	const expiryMinutes = parseExpiry(options.expiry)

	const spinner = createSpinner('Creating share link...').start()
	const data = await callWispXrpc<PrivateCreateShareOutput>(agent, 'place.wisp.v2.privateSite.createShare', {
		serviceDid: options.service,
		data: {
			siteId,
			label: options.label,
			...(expiryMinutes === undefined ? {} : { expiryMinutes }),
		},
	})
	spinner.succeed('Share link created')

	console.log()
	console.log(pc.bold('Shareable link:'))
	console.log(pc.cyan(data.url))
	console.log()
	console.log(`${pc.dim('share id:')} ${data.shareId}  ${formatExpiry(data.expiresAt)}`)
	// The credential lives in the URL and is not stored in retrievable form, so this is
	// the only time it can be shown.
	console.log(pc.yellow('This link is shown once and cannot be retrieved later. Store it now.'))
	console.log(pc.dim(`Revoke it with: wisp private revoke ${siteId} ${data.shareId}`))
}

export async function privateShares(agent: Agent, siteId: string, options: XrpcCommandOptions): Promise<void> {
	const spinner = createSpinner('Fetching share links...').start()
	const data = await callWispXrpc<PrivateListSharesOutput>(agent, 'place.wisp.v2.privateSite.listShares', {
		serviceDid: options.service,
		params: { siteId },
	})
	spinner.succeed('Fetched share links')

	if (data.shares.length === 0) {
		console.log(pc.dim('No share links for this site.'))
		return
	}

	console.log(pc.bold(`\nShare links (${data.shares.length})`))
	for (const share of data.shares) {
		const color = share.status === 'active' ? pc.green : share.status === 'revoked' ? pc.red : pc.yellow
		const label = share.label ? ` ${pc.dim(`(${share.label})`)}` : ''
		console.log(`- ${share.shareId}${label} ${color(share.status)}`)
		// Only the non-secret display prefix is ever available here.
		console.log(`  ${pc.dim('token:')} ${share.tokenPrefix}...  ${formatExpiry(share.expiresAt)}`)
		if (share.lastUsedAt) {
			console.log(`  ${pc.dim('last used:')} ${new Date(share.lastUsedAt).toISOString()}`)
		}
	}
}

export async function privateRevoke(
	agent: Agent,
	siteId: string,
	shareId: string,
	options: XrpcCommandOptions,
): Promise<void> {
	const spinner = createSpinner('Revoking share link...').start()
	await callWispXrpc(agent, 'place.wisp.v2.privateSite.revokeShare', {
		serviceDid: options.service,
		data: { siteId, shareId },
	})
	spinner.succeed(`Revoked share ${shareId}`)
}

export { authenticateForXrpc }
