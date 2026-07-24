#!/usr/bin/env bun
import { cancel, confirm, intro, isCancel, type Option, outro, select, text } from '@clack/prompts'
import type { OutputSchema as SiteDeleteOutput } from '@wispplace/lexicons/types/place/wisp/v2/site/delete'
import type { OutputSchema as SiteGetListOutput } from '@wispplace/lexicons/types/place/wisp/v2/site/getList'
import { Command } from 'commander'
import { deploy } from './commands/deploy.ts'
import {
	claimCustomDomain,
	claimWispSubdomain,
	deleteDomain,
	getDomainStatus,
	mapDomainToSite,
	verifyDomain,
} from './commands/domain.ts'
import { listDomains, listSites } from './commands/list.ts'
import {
	privateDelete,
	privateDeploy,
	privateList,
	privateRevoke,
	privateShare,
	privateShares,
} from './commands/private.ts'
import { pull } from './commands/pull.ts'
import { serve } from './commands/serve.ts'
import { authenticate, authenticateOAuth, clearDirSession, clearSessions, hasDirSession } from './lib/auth.ts'
import {
	addXrpcAuthOptions,
	authenticateForXrpc,
	bindAuthStatusToSpinner,
	withExit,
	type XrpcCommandOptions,
} from './lib/command-utils.ts'
import { createSpinner, pc } from './lib/progress.ts'
import { callWispXrpc } from './lib/xrpc.ts'

const program = new Command()
program.enablePositionalOptions()

async function promptRequiredText(
	message: string,
	options: {
		placeholder?: string
		defaultValue?: string
		validate?: (value: string) => string | Error | undefined
		cancelMessage: string
	},
): Promise<string> {
	const result = await text({
		message,
		placeholder: options.placeholder,
		defaultValue: options.defaultValue,
		validate: options.validate,
	})

	if (isCancel(result)) {
		cancel(options.cancelMessage)
		process.exit(0)
	}

	return result
}

async function promptSelect<T extends string>(
	message: string,
	choices: Option<T>[],
	cancelMessage: string,
): Promise<T> {
	const result = await select({
		message,
		options: choices,
	})

	if (isCancel(result)) {
		cancel(cancelMessage)
		process.exit(0)
	}

	return result as T
}

async function promptConfirm(message: string, cancelMessage: string): Promise<boolean> {
	const result = await confirm({ message })

	if (isCancel(result)) {
		cancel(cancelMessage)
		process.exit(0)
	}

	return result
}

async function deleteSiteWithSelection(
	identifier: string | undefined,
	options: XrpcCommandOptions & { site?: string; yes?: boolean },
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	let siteRkey = options.site
	if (!siteRkey) {
		const fetchSpinner = createSpinner('Fetching sites...').start()
		const listData = await callWispXrpc<SiteGetListOutput>(agent, 'place.wisp.v2.site.getList', {
			serviceDid,
		})
		fetchSpinner.succeed('Fetched sites')

		if (listData.sites.length === 0) {
			throw new Error('No sites found for this account')
		}

		siteRkey = await promptSelect(
			'Select site to delete',
			listData.sites.map((site) => ({
				value: site.siteRkey,
				label: site.displayName ? `${site.siteRkey} (${site.displayName})` : site.siteRkey,
				hint: site.domains.length > 0 ? `${site.domains.length} mapped domain(s)` : undefined,
			})),
			'Site deletion cancelled',
		)
	}

	if (!options.yes) {
		const shouldDelete = await promptConfirm(
			`Delete site "${siteRkey}" and unmap its domains?`,
			'Site deletion cancelled',
		)
		if (!shouldDelete) {
			cancel('Site deletion cancelled')
			process.exit(0)
		}
	}

	const deleteSpinner = createSpinner(`Deleting site ${siteRkey}...`).start()
	const data = await callWispXrpc<SiteDeleteOutput>(agent, 'place.wisp.v2.site.delete', {
		serviceDid,
		data: { siteRkey },
	})
	deleteSpinner.succeed(`Deleted site ${data.siteRkey}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.siteRkey)} deleted`)
	if (data.unmappedDomains.length > 0) {
		console.log('Unmapped domains:')
		for (const domain of data.unmappedDomains) {
			console.log(`- ${domain.domain} [${domain.kind}] ${domain.status}`)
		}
	}
}

program
	.name('wisp-cli')
	.description('CLI for wisp.place - deploy static sites to the AT Protocol')
	.version('1.1.3')
	.option('-q, --quiet', 'Suppress progress output — useful for CI/agents (also set via WISPCTL_NO_PROGRESS=1)')

// Deploy command (default)
program
	.command('deploy [handle]', { isDefault: true })
	.description('Deploy a static site to wisp.place')
	.option('-p, --path <path>', 'Directory to deploy')
	.option('-s, --site <name>', 'Site name (defaults to directory name)')
	.option('--directory', 'Enable directory listing')
	.option('--spa', 'Enable SPA mode (serve index.html for all routes)')
	.option('-c, --concurrency <n>', 'Number of concurrent uploads (backs off to 2 on rate limit)', '3')
	.option('--force-gzip', 'Force gzip compression for all files regardless of type')
	.option('--password <password>', 'App password for headless authentication')
	.option('--db <path>', 'OAuth session database path')
	.option('-y, --yes', 'Skip confirmation prompts')
	.action(
		withExit(async (handle: string | undefined, options) => {
			let resolvedHandle = handle
			let resolvedPath = options.path
			let resolvedSite = options.site

			const hasDirSess = !resolvedHandle && !options.password && (await hasDirSession(options.db))
			const needsHandlePrompt = !resolvedHandle && !hasDirSess
			const needsPrompts = needsHandlePrompt || !resolvedPath || !resolvedSite

			if (needsPrompts) {
				intro(pc.cyan('wisp.place deploy'))

				if (needsHandlePrompt) {
					resolvedHandle = await promptRequiredText('AT Protocol handle', {
						placeholder: 'alice.bsky.social',
						cancelMessage: 'Deploy cancelled',
						validate: (value) => {
							if (!value) return 'Handle is required'
							if (!value.includes('.')) return 'Handle must include a domain (e.g., alice.bsky.social)'
							return undefined
						},
					})
				}

				if (!resolvedPath) {
					resolvedPath = await promptRequiredText('Directory to deploy', {
						placeholder: '.',
						defaultValue: '.',
						cancelMessage: 'Deploy cancelled',
					})
				}

				if (!resolvedSite) {
					resolvedSite = await promptRequiredText('Site name', {
						placeholder: 'my-website',
						cancelMessage: 'Deploy cancelled',
						validate: (value) => {
							if (!value) return 'Site name is required'
							if (!/^[a-zA-Z0-9._~:-]{1,512}$/.test(value)) {
								return 'Site name must be 1-512 characters of [a-zA-Z0-9._~:-]'
							}
							return undefined
						},
					})
				}
			}

			const authSpinner = createSpinner('Authenticating...').start()
			const { agent, did } = await authenticate(resolvedHandle, {
				appPassword: options.password,
				dbPath: options.db,
				onStatus: bindAuthStatusToSpinner(authSpinner),
			})
			authSpinner.succeed(`Authenticated as ${did}`)

			const result = await deploy(agent, did, {
				path: resolvedPath,
				site: resolvedSite,
				directory: options.directory,
				spa: options.spa,
				yes: options.yes,
				concurrency: parseInt(options.concurrency, 10),
				forceGzip: options.forceGzip,
			})

			console.log()
			console.log(pc.dim(`  URI: ${result.uri}`))
			if (resolvedHandle) {
				console.log(pc.cyan(`  URL: https://sites.wisp.place/${resolvedHandle}/${resolvedSite}`))
			}
			console.log(pc.cyan(`  URL: ${result.url}`))

			if (needsPrompts) {
				outro(pc.green('Deployed successfully!'))
			} else {
				console.log()
				console.log(pc.green('✓ Deployed successfully!'))
			}
		}),
	)

// Pull command
program
	.command('pull <handle>')
	.description('Download a site from wisp.place to a local directory')
	.requiredOption('-s, --site <name>', 'Site name to pull')
	.option('-p, --path <path>', 'Output directory', '.')
	.action(
		withExit(async (handle: string, options) => {
			await pull(handle, {
				site: options.site,
				path: options.path,
			})
		}),
	)

// Serve command
program
	.command('serve <handle>')
	.description('Serve a site locally with live updates from firehose')
	.requiredOption('-s, --site <name>', 'Site name to serve')
	.option('-p, --path <path>', 'Local directory to cache site', '.wisp-serve')
	.option('-P, --port <port>', 'Port to serve on', '8080')
	.option('--spa [file]', 'Enable SPA mode (serve file for all unmatched routes, defaults to index.html)')
	.option('--directory-listing', 'Enable directory listing')
	.action(
		withExit(async (handle: string, options) => {
			await serve(handle, {
				site: options.site,
				path: options.path,
				port: parseInt(options.port, 10),
				spa: options.spa,
				directoryListing: options.directoryListing,
			})
		}),
	)

// Logout command
const listCommand = program
	.command('list')
	.description('List sites and domains from wisp XRPC routes')
	.enablePositionalOptions()

addXrpcAuthOptions(listCommand).action(
	withExit(async (options) => {
		intro(pc.cyan('wisp.place list'))
		const action = await promptSelect(
			'What do you want to list?',
			[
				{ value: 'domains', label: 'Domains', hint: 'Claimed, pending, and mapped domains' },
				{ value: 'sites', label: 'Sites', hint: 'Sites with mapped domains' },
			],
			'List cancelled',
		)

		if (action === 'domains') {
			await listDomains(undefined, options)
			return
		}

		await listSites(undefined, options)
	}),
)

addXrpcAuthOptions(listCommand.command('domains [handle]').description('List domains for an account')).action(
	withExit(async (handle: string | undefined, options) => {
		await listDomains(handle, options)
	}),
)

addXrpcAuthOptions(
	listCommand.command('sites [handle]').description('List sites and their mapped domains for an account'),
).action(
	withExit(async (handle: string | undefined, options) => {
		await listSites(handle, options)
	}),
)

const domainCommand = program
	.command('domain')
	.alias('domains')
	.description('Manage domains with wisp XRPC')
	.enablePositionalOptions()

addXrpcAuthOptions(
	domainCommand
		.command('claim [handle]')
		.description('Claim a custom domain')
		.option('-d, --domain <domain>', 'Custom domain')
		.option('-s, --site <rkey>', 'Optional site rkey to map'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const domain =
			options.domain ??
			(await promptRequiredText('Custom domain', {
				placeholder: 'example.com',
				cancelMessage: 'Claim cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			}))
		await claimCustomDomain(handle, domain, options.site, options)
	}),
)

addXrpcAuthOptions(
	domainCommand
		.command('claim-subdomain [handle]')
		.description('Claim a wisp subdomain')
		.option('-n, --subdomain <name>', 'Subdomain handle')
		.option('-s, --site <rkey>', 'Optional site rkey to map'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const subdomain =
			options.subdomain ??
			(await promptRequiredText('Subdomain handle', {
				placeholder: 'alice',
				cancelMessage: 'Claim cancelled',
				validate: (value) => (!value ? 'Subdomain is required' : undefined),
			}))
		await claimWispSubdomain(handle, subdomain, options.site, options)
	}),
)

addXrpcAuthOptions(
	domainCommand
		.command('status [handle]')
		.description('Get domain verification/claim status')
		.option('-d, --domain <domain>', 'Domain'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const domain =
			options.domain ??
			(await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Status check cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			}))
		await getDomainStatus(handle, domain, options)
	}),
)

addXrpcAuthOptions(
	domainCommand
		.command('add-site [handle]')
		.description('Map a claimed domain to a site rkey')
		.option('-d, --domain <domain>', 'Domain')
		.option('-s, --site <rkey>', 'Site rkey'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const domain =
			options.domain ??
			(await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Add-site cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			}))
		const site =
			options.site ??
			(await promptRequiredText('Site rkey', {
				placeholder: 'mysite',
				cancelMessage: 'Add-site cancelled',
				validate: (value) => (!value ? 'Site rkey is required' : undefined),
			}))
		await mapDomainToSite(handle, domain, site, options)
	}),
)

addXrpcAuthOptions(
	domainCommand
		.command('delete [handle]')
		.description('Delete a claimed domain')
		.option('-d, --domain <domain>', 'Domain'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const domain =
			options.domain ??
			(await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Delete cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			}))
		await deleteDomain(handle, domain, options)
	}),
)

addXrpcAuthOptions(
	domainCommand
		.command('verify [handle]')
		.description('Run DNS verification for a claimed custom domain')
		.option('-d, --domain <domain>', 'Domain'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const domain =
			options.domain ??
			(await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Verify cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			}))
		await verifyDomain(handle, domain, options)
	}),
)

const siteCommand = program.command('site').description('Manage sites with wisp XRPC').enablePositionalOptions()

addXrpcAuthOptions(domainCommand).action(
	withExit(async (options) => {
		intro(pc.cyan('wisp.place domain'))
		const action = await promptSelect(
			'Choose domain action',
			[
				{ value: 'claim', label: 'Claim custom domain' },
				{ value: 'claim-subdomain', label: 'Claim wisp subdomain' },
				{ value: 'status', label: 'Get domain status' },
				{ value: 'add-site', label: 'Map domain to site' },
				{ value: 'verify', label: 'Verify domain' },
				{ value: 'delete', label: 'Delete domain' },
			],
			'Domain command cancelled',
		)

		if (action === 'claim') {
			const domain = await promptRequiredText('Custom domain', {
				placeholder: 'example.com',
				cancelMessage: 'Claim cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			})
			await claimCustomDomain(undefined, domain, undefined, options)
			return
		}

		if (action === 'claim-subdomain') {
			const subdomain = await promptRequiredText('Subdomain handle', {
				placeholder: 'alice',
				cancelMessage: 'Claim cancelled',
				validate: (value) => (!value ? 'Subdomain is required' : undefined),
			})
			await claimWispSubdomain(undefined, subdomain, undefined, options)
			return
		}

		if (action === 'status') {
			const domain = await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Status check cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			})
			await getDomainStatus(undefined, domain, options)
			return
		}

		if (action === 'add-site') {
			const domain = await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Add-site cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			})
			const site = await promptRequiredText('Site rkey', {
				placeholder: 'mysite',
				cancelMessage: 'Add-site cancelled',
				validate: (value) => (!value ? 'Site rkey is required' : undefined),
			})
			await mapDomainToSite(undefined, domain, site, options)
			return
		}

		if (action === 'verify') {
			const domain = await promptRequiredText('Domain', {
				placeholder: 'example.com',
				cancelMessage: 'Verify cancelled',
				validate: (value) => (!value ? 'Domain is required' : undefined),
			})
			await verifyDomain(undefined, domain, options)
			return
		}

		const domain = await promptRequiredText('Domain', {
			placeholder: 'example.com',
			cancelMessage: 'Delete cancelled',
			validate: (value) => (!value ? 'Domain is required' : undefined),
		})
		await deleteDomain(undefined, domain, options)
	}),
)

addXrpcAuthOptions(siteCommand).action(
	withExit(async (options) => {
		intro(pc.cyan('wisp.place site'))
		const action = await promptSelect(
			'Choose site action',
			[
				{ value: 'list', label: 'List sites', hint: 'Show sites and mapped domains' },
				{ value: 'delete', label: 'Delete site', hint: 'Remove site mapping metadata' },
			],
			'Site command cancelled',
		)

		if (action === 'list') {
			await listSites(undefined, options)
			return
		}

		await deleteSiteWithSelection(undefined, options)
	}),
)

addXrpcAuthOptions(
	siteCommand
		.command('delete [handle]')
		.description('Delete a site from wisp metadata and unmap its domains')
		.option('-s, --site <rkey>', 'Site rkey')
		.option('-y, --yes', 'Skip delete confirmation'),
).action(
	withExit(async (handle: string | undefined, options) => {
		await deleteSiteWithSelection(handle, options)
	}),
)

const privateCommand = program
	.command('private')
	.description('Manage private sites (never published to your PDS)')
	.enablePositionalOptions()

addXrpcAuthOptions(
	privateCommand
		.command('deploy [handle]')
		.description('Upload a directory as a private site')
		.option('-p, --path <dir>', 'Directory to upload', '.')
		.option('-n, --name <name>', 'Display name for the private site')
		.option('-e, --expiry <minutes>', 'Minutes until the site expires. Omit for the server default, 0 to never expire'),
).action(
	withExit(async (handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateDeploy(agent, options)
	}),
)

addXrpcAuthOptions(privateCommand.command('list [handle]').description('List your private sites')).action(
	withExit(async (handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateList(agent, options)
	}),
)

addXrpcAuthOptions(
	privateCommand.command('delete <siteId> [handle]').description('Delete a private site and all of its share links'),
).action(
	withExit(async (siteId: string, handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateDelete(agent, siteId, options)
	}),
)

addXrpcAuthOptions(
	privateCommand
		.command('share <siteId> [handle]')
		.description('Create a shareable link for a private site')
		.option('-l, --label <label>', 'Label to identify this link')
		.option('-e, --expiry <minutes>', 'Minutes until the link expires. Omit for the server default, 0 for none'),
).action(
	withExit(async (siteId: string, handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateShare(agent, siteId, options)
	}),
)

addXrpcAuthOptions(
	privateCommand.command('shares <siteId> [handle]').description('List share links for a private site'),
).action(
	withExit(async (siteId: string, handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateShares(agent, siteId, options)
	}),
)

addXrpcAuthOptions(
	privateCommand.command('revoke <siteId> <shareId> [handle]').description('Revoke a share link immediately'),
).action(
	withExit(async (siteId: string, shareId: string, handle: string | undefined, options) => {
		const { agent } = await authenticateForXrpc(handle, options)
		await privateRevoke(agent, siteId, shareId, options)
	}),
)

// Login command
program
	.command('login <handle>')
	.description('Authenticate and store session for the current directory')
	.option('--db <path>', 'OAuth session database path')
	.action(
		withExit(async (handle: string, options) => {
			const authSpinner = createSpinner('Authenticating...').start()
			const { did } = await authenticateOAuth(handle, {
				dbPath: options.db,
				onStatus: bindAuthStatusToSpinner(authSpinner),
				forceReauth: true,
			})
			authSpinner.succeed(`Authenticated as ${did}`)
		}),
	)

// Logout command
program
	.command('logout')
	.description('Clear the stored session for the current directory')
	.option('--db <path>', 'OAuth session database path')
	.option('--all', 'Clear all stored sessions across all directories')
	.action(async (options) => {
		if (options.all) {
			await clearSessions(options.db)
		} else {
			await clearDirSession(options.db)
		}
	})

// Set WISPCTL_NO_PROGRESS from --quiet flag before any command runs
program.hook('preAction', () => {
	if (program.opts().quiet) {
		process.env.WISPCTL_NO_PROGRESS = '1'
	}
})

program.parse()
