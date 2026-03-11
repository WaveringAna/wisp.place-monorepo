import * as dgram from 'node:dgram'
import * as dnsPacket from 'dns-packet'

// Cloudflare, Google, OpenDNS — queried in parallel for NS discovery
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '208.67.222.222']

const QUERY_TIMEOUT_MS = 3000

// RD (recursion desired) flag bit
const RD_FLAG = 0x0100

/**
 * Send a raw DNS query to a specific server and parse the response.
 * recursive=true sets RD=1 (for public resolvers); false sets RD=0 (for authoritative NS).
 */
function queryDNS(
	name: string,
	type: dnsPacket.RecordType,
	server: string,
	port = 53,
	recursive = false,
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
			flags: recursive ? RD_FLAG : 0,
			questions: [{ type, name, class: 'IN' }],
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

function extractNSFromAnswer(response: dnsPacket.Packet): string[] {
	return (response.answers ?? [])
		.filter((record): record is dnsPacket.Answer & { type: 'NS'; data: string } => {
			return record.type === 'NS' && typeof record.data === 'string'
		})
		.map((record) => record.data.toLowerCase().replace(/\.$/, ''))
}

/**
 * Discover authoritative nameserver IPs for a given name.
 *
 * Walks up the label hierarchy (e.g. _wisp.example.com → example.com) querying
 * all three public resolvers in parallel (RD=1) until NS records appear in the
 * answer section. NS records only exist at zone apexes, so subdomains and
 * underscore labels are skipped automatically.
 */
async function getAuthoritativeServers(name: string): Promise<string[]> {
	const labels = name.split('.')

	for (let i = 0; i <= labels.length - 2; i++) {
		const candidate = labels.slice(i).join('.')

		let response: dnsPacket.Packet
		try {
			response = await Promise.any(PUBLIC_RESOLVERS.map((r) => queryDNS(candidate, 'NS', r, 53, true)))
		} catch {
			continue
		}

		const nsNames = extractNSFromAnswer(response)
		if (nsNames.length === 0) continue

		const glue = extractGlueRecords(response)
		const ips: string[] = []

		for (const ns of nsNames) {
			const glueIps = glue.get(ns)
			if (glueIps) ips.push(...glueIps)
		}

		if (ips.length > 0) return ips

		// No glue — resolve NS hostnames via public resolvers in parallel
		await Promise.allSettled(
			nsNames.slice(0, 3).map(async (ns) => {
				try {
					const aResp = await Promise.any(PUBLIC_RESOLVERS.map((r) => queryDNS(ns, 'A', r, 53, true)))
					for (const record of aResp.answers ?? []) {
						if (record.type === 'A' && 'data' in record && typeof record.data === 'string') {
							ips.push(record.data)
						}
					}
				} catch {}
			}),
		)

		if (ips.length > 0) return ips
	}

	throw new Error(`No NS records found for ${name}`)
}

/**
 * Query a DNS record directly from the domain's authoritative nameservers.
 * NS discovery uses public resolvers (cached, fast); the actual record query
 * goes direct to the NS with RD=0 for an authoritative answer.
 */
async function authoritativeResolve(name: string, type: dnsPacket.RecordType): Promise<dnsPacket.Packet> {
	console.log(`[DNS] Resolving ${type} ${name} via authoritative NS`)
	const servers = await getAuthoritativeServers(name)
	const shuffledServers = [...servers].sort(() => Math.random() - 0.5)

	let lastError: Error | null = null
	for (const server of shuffledServers) {
		try {
			return await queryDNS(name, type, server)
		} catch (err) {
			lastError = err as Error
		}
	}
	throw lastError ?? new Error(`All nameservers failed for ${type} ${name}`)
}

async function authoritativeResolveTxt(domain: string): Promise<string[][]> {
	const response = await authoritativeResolve(domain, 'TXT')
	const records: string[][] = []
	for (const answer of response.answers ?? []) {
		if (answer.type === 'TXT' && 'data' in answer) {
			const chunks = Array.isArray(answer.data) ? answer.data : [answer.data]
			records.push(chunks.map((d) => (Buffer.isBuffer(d) ? d.toString('utf-8') : String(d))))
		}
	}
	return records
}

async function authoritativeResolveCname(domain: string): Promise<string[]> {
	const response = await authoritativeResolve(domain, 'CNAME')
	return (response.answers ?? [])
		.filter((record): record is dnsPacket.Answer & { type: 'CNAME'; data: string } => {
			return record.type === 'CNAME' && typeof record.data === 'string'
		})
		.map((record) => record.data.toLowerCase().replace(/\.$/, ''))
}

/**
 * Result of a domain verification process
 */
export interface VerificationResult {
	/** Whether the verification was successful */
	verified: boolean
	/** Error message if verification failed */
	error?: string
	/** Warning message (e.g. duplicate records detected) */
	warning?: string
	/** DNS records found during verification */
	found?: {
		/** TXT records found (used for domain verification) */
		txt?: string[]
		/** CNAME record found (used for domain pointing) */
		cname?: string
	}
}

/**
 * Verify domain ownership via TXT record at _wisp.{domain}.
 * Expected value: the user's DID (did:plc:xxx or did:web:xxx).
 */
export const verifyDomainOwnership = async (domain: string, expectedDid: string): Promise<VerificationResult> => {
	try {
		const txtDomain = `_wisp.${domain}`
		console.log(`[DNS Verify] Checking TXT ${txtDomain}, expected: ${expectedDid}`)

		const records = await authoritativeResolveTxt(txtDomain)
		const foundTxtValues = records.map((r) => r.join(''))
		console.log(`[DNS Verify] Found TXT records:`, foundTxtValues)

		if (foundTxtValues.some((v) => v === expectedDid)) {
			console.log(`[DNS Verify] ✓ TXT record matches`)
			const extras = foundTxtValues.filter((v) => v !== expectedDid)
			const warning =
				extras.length > 0
					? `Multiple TXT records found at ${txtDomain}. Remove the extra record(s) to avoid issues: ${extras.join(', ')}`
					: undefined
			if (warning) console.log(`[DNS Verify] ⚠️  ${warning}`)
			return { verified: true, warning, found: { txt: foundTxtValues } }
		}

		console.log(`[DNS Verify] ✗ TXT record does not match`)
		return {
			verified: false,
			error: `TXT record at ${txtDomain} does not match expected DID. Expected: ${expectedDid}`,
			found: { txt: foundTxtValues },
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.log(`[DNS Verify] ✗ TXT lookup error:`, message)
		return {
			verified: false,
			error: `DNS lookup failed: ${message}`,
			found: { txt: [] },
		}
	}
}

/**
 * Verify CNAME record points to {hash}.dns.wisp.place.
 */
export const verifyCNAME = async (domain: string, expectedHash: string): Promise<VerificationResult> => {
	try {
		const expectedTarget = `${expectedHash}.dns.wisp.place`
		console.log(`[DNS Verify] Checking CNAME ${domain}, expected: ${expectedTarget}`)

		const cnames = await authoritativeResolveCname(domain)
		const foundCname = cnames[0] ?? null
		console.log(`[DNS Verify] Found CNAME:`, foundCname ?? 'none')

		if (!foundCname) {
			return { verified: false, error: `No CNAME record found for ${domain}`, found: { cname: '' } }
		}

		if (foundCname === expectedTarget.toLowerCase()) {
			console.log(`[DNS Verify] ✓ CNAME record matches`)
			return { verified: true, found: { cname: foundCname } }
		}

		console.log(`[DNS Verify] ✗ CNAME record does not match`)
		return {
			verified: false,
			error: `CNAME for ${domain} points to ${foundCname}, expected ${expectedTarget}`,
			found: { cname: foundCname },
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.log(`[DNS Verify] ✗ CNAME lookup error:`, message)
		return {
			verified: false,
			error: `DNS lookup failed: ${message}`,
			found: { cname: '' },
		}
	}
}

/**
 * Verify a custom domain by checking both TXT ownership proof and CNAME routing.
 * TXT is authoritative — CNAME is advisory (may be flattened by providers like Cloudflare).
 */
export const verifyCustomDomain = async (
	domain: string,
	expectedDid: string,
	expectedHash: string,
): Promise<VerificationResult> => {
	const txtResult = await verifyDomainOwnership(domain, expectedDid)
	if (!txtResult.verified) {
		return txtResult
	}

	const cnameResult = await verifyCNAME(domain, expectedHash)
	if (!cnameResult.verified) {
		console.log(`[DNS Verify] ⚠️  CNAME verification failed (may be flattened):`, cnameResult.error)
	}

	return {
		verified: true,
		warning: txtResult.warning,
		found: {
			txt: txtResult.found?.txt,
			cname: cnameResult.found?.cname,
		},
	}
}
