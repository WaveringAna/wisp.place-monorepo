import * as dgram from 'dgram'
import * as dnsPacket from 'dns-packet'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Parse the named.root hints file to extract IPv4 addresses.
 * Source: https://www.internic.net/domain/named.root
 * Format: lines like "A.ROOT-SERVERS.NET.  3600000  A  198.41.0.4"
 */
function loadRootServers(): string[] {
	const text = readFileSync(join(import.meta.dir, 'named.root'), 'utf-8')
	const ips: string[] = []
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed.startsWith(';') || trimmed === '') continue
		const match = trimmed.match(/^\S+\s+\d+\s+A\s+(\d+\.\d+\.\d+\.\d+)$/i)
		if (match) {
			ips.push(match[1])
		}
	}
	if (ips.length === 0) {
		throw new Error('Failed to parse any root servers from named.root')
	}
	return ips
}

const ROOT_SERVERS = loadRootServers()

const QUERY_TIMEOUT_MS = 5000
const MAX_RECURSION_DEPTH = 10

/**
 * Pick a random element from an array
 */
function pickRandom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Send a raw DNS query to a specific server and parse the response.
 * Handles both authoritative answers and referral responses.
 */
function queryDNS(
	name: string,
	type: dnsPacket.RecordType,
	server: string,
	port = 53
): Promise<dnsPacket.Packet> {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket('udp4')
		const timer = setTimeout(() => {
			socket.close()
			reject(new Error(`DNS query timed out: ${type} ${name} @${server}`))
		}, QUERY_TIMEOUT_MS)

		const query = dnsPacket.encode({
			type: 'query',
			id: Math.floor(Math.random() * 65535),
			flags: 0, // No recursion desired — we handle it ourselves
			questions: [{ type, name, class: 'IN' }]
		})

		socket.on('message', (msg) => {
			clearTimeout(timer)
			socket.close()
			try {
				resolve(dnsPacket.decode(msg))
			} catch (err) {
				reject(new Error(`Failed to decode DNS response for ${type} ${name}: ${err}`))
			}
		})

		socket.on('error', (err) => {
			clearTimeout(timer)
			socket.close()
			reject(err)
		})

		socket.send(query, 0, query.length, port, server)
	})
}

/**
 * Extract IPv4 glue records from the additional section of a DNS response.
 * These are A records for nameservers mentioned in the authority section.
 */
function extractGlueRecords(response: dnsPacket.Packet): Map<string, string[]> {
	const glue = new Map<string, string[]>()
	for (const record of response.additionals ?? []) {
		if (record.type === 'A' && 'data' in record && typeof record.data === 'string') {
			const name = record.name.toLowerCase().replace(/\.$/, '')
			const existing = glue.get(name) ?? []
			existing.push(record.data)
			glue.set(name, existing)
		}
	}
	return glue
}

/**
 * Extract NS hostnames from the authority section of a referral response.
 */
function extractNSFromAuthority(response: dnsPacket.Packet): string[] {
	const nsNames: string[] = []
	for (const record of response.authorities ?? []) {
		if (record.type === 'NS' && 'data' in record && typeof record.data === 'string') {
			nsNames.push(record.data.toLowerCase().replace(/\.$/, ''))
		}
	}
	return nsNames
}

/**
 * Extract NS hostnames from the answer section.
 */
function extractNSFromAnswer(response: dnsPacket.Packet): string[] {
	const nsNames: string[] = []
	for (const record of response.answers ?? []) {
		if (record.type === 'NS' && 'data' in record && typeof record.data === 'string') {
			nsNames.push(record.data.toLowerCase().replace(/\.$/, ''))
		}
	}
	return nsNames
}

/**
 * Resolve a nameserver hostname to an IP address.
 * Uses the system resolver as a fallback for resolving NS hostnames to IPs
 * when glue records are not available.
 */
async function resolveNStoIP(nsName: string): Promise<string | null> {
	try {
		// Do a recursive resolve from root for the NS hostname itself
		const response = await recursiveResolve(nsName, 'A', ROOT_SERVERS, 0)
		for (const record of response.answers ?? []) {
			if (record.type === 'A' && 'data' in record && typeof record.data === 'string') {
				return record.data
			}
		}
	} catch {
		// Fallback: use system resolver
		try {
			const { Resolver } = await import('dns')
			const resolver = new Resolver()
			const ips = await new Promise<string[]>((resolve, reject) => {
				resolver.resolve4(nsName, (err, addresses) => {
					if (err) reject(err)
					else resolve(addresses)
				})
			})
			if (ips.length > 0) return ips[0]
		} catch {
			// Both methods failed
		}
	}
	return null
}

/**
 * Get usable IP addresses for nameservers from a referral response.
 * First tries glue records, then resolves NS hostnames.
 */
async function getServerIPsFromReferral(response: dnsPacket.Packet): Promise<string[]> {
	const nsNames = extractNSFromAuthority(response)
	if (nsNames.length === 0) return []

	const glue = extractGlueRecords(response)
	const ips: string[] = []

	// First, collect all IPs from glue records
	for (const ns of nsNames) {
		const glueIps = glue.get(ns)
		if (glueIps) {
			ips.push(...glueIps)
		}
	}

	// If we have glue IPs, use them
	if (ips.length > 0) return ips

	// Otherwise, resolve NS hostnames (this is rare but happens with out-of-bailiwick NS)
	for (const ns of nsNames) {
		const ip = await resolveNStoIP(ns)
		if (ip) {
			ips.push(ip)
			// One is enough to continue
			if (ips.length >= 2) break
		}
	}

	return ips
}

/**
 * Recursively resolve a DNS query starting from the given servers.
 * Follows referrals (NS delegations) down the DNS tree until we get
 * an authoritative answer or hit max depth.
 */
async function recursiveResolve(
	name: string,
	type: dnsPacket.RecordType,
	servers: string[],
	depth: number
): Promise<dnsPacket.Packet> {
	if (depth >= MAX_RECURSION_DEPTH) {
		throw new Error(`Max recursion depth reached resolving ${type} ${name}`)
	}

	const server = pickRandom(servers)
	const response = await queryDNS(name, type, server)

	// Check if we got an authoritative answer
	const hasAnswers = (response.answers?.length ?? 0) > 0
	if (hasAnswers) {
		return response
	}

	// Check for NXDOMAIN or NODATA (authoritative negative response)
	const rcode = response.rcode
	if (rcode === 'NXDOMAIN' || rcode === 'NOTFOUND') {
		return response // No such domain
	}

	// Check if this is a referral (has authority NS records)
	const nsNames = extractNSFromAuthority(response)
	if (nsNames.length === 0) {
		// No answers and no referrals — return what we have
		return response
	}

	// Follow the referral
	const nextServers = await getServerIPsFromReferral(response)
	if (nextServers.length === 0) {
		throw new Error(`Could not resolve any NS IPs for referral while resolving ${type} ${name}`)
	}

	return recursiveResolve(name, type, nextServers, depth + 1)
}

/**
 * Resolve a DNS query from root nameservers to authoritative answer.
 */
async function authoritativeResolve(name: string, type: dnsPacket.RecordType): Promise<dnsPacket.Packet> {
	console.log(`[DNS Recursive] Resolving ${type} ${name} from root`)
	return recursiveResolve(name, type, ROOT_SERVERS, 0)
}

/**
 * Query TXT records from authoritative nameservers, resolved from root.
 */
async function authoritativeResolveTxt(domain: string): Promise<string[][]> {
	const response = await authoritativeResolve(domain, 'TXT')

	const records: string[][] = []
	for (const answer of response.answers ?? []) {
		if (answer.type === 'TXT' && 'data' in answer) {
			const data = answer.data as Buffer | Buffer[] | string | string[]
			if (Array.isArray(data)) {
				records.push(data.map(d => Buffer.isBuffer(d) ? d.toString('utf-8') : String(d)))
			} else if (Buffer.isBuffer(data)) {
				records.push([data.toString('utf-8')])
			} else {
				records.push([String(data)])
			}
		}
	}

	return records
}

/**
 * Query CNAME records from authoritative nameservers, resolved from root.
 */
async function authoritativeResolveCname(domain: string): Promise<string[]> {
	const response = await authoritativeResolve(domain, 'CNAME')

	const records: string[] = []
	for (const answer of response.answers ?? []) {
		if (answer.type === 'CNAME' && 'data' in answer && typeof answer.data === 'string') {
			records.push(answer.data.toLowerCase().replace(/\.$/, ''))
		}
	}

	return records
}

/**
 * Result of a domain verification process
 */
export interface VerificationResult {
	/** Whether the verification was successful */
	verified: boolean
	/** Error message if verification failed */
	error?: string
	/** DNS records found during verification */
	found?: {
		/** TXT records found (used for domain verification) */
		txt?: string[]
		/** CNAME record found (used for domain pointing) */
		cname?: string
	}
}

/**
 * Verify domain ownership via TXT record at _wisp.{domain}
 * Expected format: did:plc:xxx or did:web:xxx
 *
 * Resolves from root nameservers to get authoritative answers.
 */
export const verifyDomainOwnership = async (domain: string, expectedDid: string): Promise<VerificationResult> => {
	try {
		const txtDomain = `_wisp.${domain}`

		console.log(`[DNS Verify] Checking TXT record for ${txtDomain} (recursive from root)`)
		console.log(`[DNS Verify] Expected DID: ${expectedDid}`)

		const records = await authoritativeResolveTxt(txtDomain)

		const foundTxtValues = records.map((record) => record.join(''))
		console.log(`[DNS Verify] Found TXT records:`, foundTxtValues)

		for (const record of records) {
			const txtValue = record.join('')
			if (txtValue === expectedDid) {
				console.log(`[DNS Verify] ✓ TXT record matches!`)
				return { verified: true, found: { txt: foundTxtValues } }
			}
		}

		console.log(`[DNS Verify] ✗ TXT record does not match`)
		return {
			verified: false,
			error: `TXT record at ${txtDomain} does not match expected DID. Expected: ${expectedDid}`,
			found: { txt: foundTxtValues },
		}
	} catch (err: any) {
		console.log(`[DNS Verify] ✗ TXT lookup error:`, err.message)
		if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
			return {
				verified: false,
				error: `No TXT record found at _wisp.${domain}`,
				found: { txt: [] },
			}
		}
		return {
			verified: false,
			error: `DNS lookup failed: ${err.message}`,
			found: { txt: [] },
		}
	}
}

/**
 * Verify CNAME record points to the expected hash target
 * For custom domains, we expect: domain CNAME -> {hash}.dns.wisp.place
 *
 * Resolves from root nameservers to get authoritative answers.
 */
export const verifyCNAME = async (domain: string, expectedHash: string): Promise<VerificationResult> => {
	try {
		console.log(`[DNS Verify] Checking CNAME record for ${domain} (recursive from root)`)
		const expectedTarget = `${expectedHash}.dns.wisp.place`
		console.log(`[DNS Verify] Expected CNAME: ${expectedTarget}`)

		const cname = await authoritativeResolveCname(domain)

		const foundCname = cname.length > 0 ? cname[0]?.toLowerCase().replace(/\.$/, '') : null
		console.log(`[DNS Verify] Found CNAME:`, foundCname || 'none')

		if (cname.length === 0 || !foundCname) {
			console.log(`[DNS Verify] ✗ No CNAME record found`)
			return {
				verified: false,
				error: `No CNAME record found for ${domain}`,
				found: { cname: '' },
			}
		}

		const actualTarget = foundCname

		if (actualTarget === expectedTarget.toLowerCase()) {
			console.log(`[DNS Verify] ✓ CNAME record matches!`)
			return { verified: true, found: { cname: actualTarget } }
		}

		console.log(`[DNS Verify] ✗ CNAME record does not match`)
		return {
			verified: false,
			error: `CNAME for ${domain} points to ${actualTarget}, expected ${expectedTarget}`,
			found: { cname: actualTarget },
		}
	} catch (err: any) {
		console.log(`[DNS Verify] ✗ CNAME lookup error:`, err.message)
		if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
			return {
				verified: false,
				error: `No CNAME record found for ${domain}`,
				found: { cname: '' },
			}
		}
		return {
			verified: false,
			error: `DNS lookup failed: ${err.message}`,
			found: { cname: '' },
		}
	}
}

/**
 * Verify custom domain using TXT record as authoritative proof
 * CNAME check is optional/advisory - TXT record is sufficient for verification
 *
 * This approach works with CNAME flattening (e.g., Cloudflare) where the CNAME
 * is resolved to A/AAAA records and won't be visible in DNS queries.
 *
 * All queries are resolved recursively from root nameservers for authoritative answers.
 */
export const verifyCustomDomain = async (
	domain: string,
	expectedDid: string,
	expectedHash: string,
): Promise<VerificationResult> => {
	// TXT record is authoritative - it proves ownership
	const txtResult = await verifyDomainOwnership(domain, expectedDid)
	if (!txtResult.verified) {
		return txtResult
	}

	// CNAME check is advisory only - we still check it for logging/debugging
	// but don't fail verification if it's missing (could be flattened)
	const cnameResult = await verifyCNAME(domain, expectedHash)

	// Log CNAME status for debugging, but don't fail on it
	if (!cnameResult.verified) {
		console.log(`[DNS Verify] ⚠️  CNAME verification failed (may be flattened):`, cnameResult.error)
	}

	// TXT verification is sufficient
	return {
		verified: true,
		found: {
			txt: txtResult.found?.txt,
			cname: cnameResult.found?.cname,
		},
	}
}
