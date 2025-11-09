import { promises as dns } from 'dns'

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
 */
export const verifyDomainOwnership = async (
	domain: string,
	expectedDid: string
): Promise<VerificationResult> => {
	try {
		const txtDomain = `_wisp.${domain}`

		console.log(`[DNS Verify] Checking TXT record for ${txtDomain}`)
		console.log(`[DNS Verify] Expected DID: ${expectedDid}`)

		// Query TXT records
		const records = await dns.resolveTxt(txtDomain)

		// Log what we found
		const foundTxtValues = records.map((record) => record.join(''))
		console.log(`[DNS Verify] Found TXT records:`, foundTxtValues)

		// TXT records come as arrays of strings (for multi-part records)
		// We need to join them and check if any match the expected DID
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
			found: { txt: foundTxtValues }
		}
	} catch (err: any) {
		console.log(`[DNS Verify] ✗ TXT lookup error:`, err.message)
		if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
			return {
				verified: false,
				error: `No TXT record found at _wisp.${domain}`,
				found: { txt: [] }
			}
		}
		return {
			verified: false,
			error: `DNS lookup failed: ${err.message}`,
			found: { txt: [] }
		}
	}
}

/**
 * Verify CNAME record points to the expected hash target
 * For custom domains, we expect: domain CNAME -> {hash}.dns.wisp.place
 */
export const verifyCNAME = async (
	domain: string,
	expectedHash: string
): Promise<VerificationResult> => {
	try {
		console.log(`[DNS Verify] Checking CNAME record for ${domain}`)
		const expectedTarget = `${expectedHash}.dns.wisp.place`
		console.log(`[DNS Verify] Expected CNAME: ${expectedTarget}`)

		// Resolve CNAME for the domain
		const cname = await dns.resolveCname(domain)

		// Log what we found
		const foundCname =
			cname.length > 0
				? cname[0]?.toLowerCase().replace(/\.$/, '')
				: null
		console.log(`[DNS Verify] Found CNAME:`, foundCname || 'none')

		if (cname.length === 0 || !foundCname) {
			console.log(`[DNS Verify] ✗ No CNAME record found`)
			return {
				verified: false,
				error: `No CNAME record found for ${domain}`,
				found: { cname: '' }
			}
		}

		// Check if CNAME points to the expected target
		const actualTarget = foundCname

		if (actualTarget === expectedTarget.toLowerCase()) {
			console.log(`[DNS Verify] ✓ CNAME record matches!`)
			return { verified: true, found: { cname: actualTarget } }
		}

		console.log(`[DNS Verify] ✗ CNAME record does not match`)
		return {
			verified: false,
			error: `CNAME for ${domain} points to ${actualTarget}, expected ${expectedTarget}`,
			found: { cname: actualTarget }
		}
	} catch (err: any) {
		console.log(`[DNS Verify] ✗ CNAME lookup error:`, err.message)
		if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
			return {
				verified: false,
				error: `No CNAME record found for ${domain}`,
				found: { cname: '' }
			}
		}
		return {
			verified: false,
			error: `DNS lookup failed: ${err.message}`,
			found: { cname: '' }
		}
	}
}

/**
 * Verify custom domain using TXT record as authoritative proof
 * CNAME check is optional/advisory - TXT record is sufficient for verification
 *
 * This approach works with CNAME flattening (e.g., Cloudflare) where the CNAME
 * is resolved to A/AAAA records and won't be visible in DNS queries.
 */
export const verifyCustomDomain = async (
	domain: string,
	expectedDid: string,
	expectedHash: string
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
			cname: cnameResult.found?.cname
		}
	}
}
