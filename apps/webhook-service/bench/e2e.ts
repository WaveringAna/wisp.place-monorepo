/**
 * End-to-end integration test against a real PDS and Jetstream.
 *
 * Flow:
 *   1. Spin up a local delivery server to receive webhook POSTs.
 *   2. Connect JetstreamClient watching the test DID.
 *   3. Create place.wisp.v2.wh on PDS → Jetstream delivers it → lands in local DB.
 *   4. Create app.bsky.feed.post → direct match fires → delivery #1.
 *   5. Create app.bsky.feed.like at the post → backlink fires → delivery #2.
 *   6. Delete all created records. Print timing.
 *
 * Env vars (set in .env or prefix the command):
 *   TEST_PDS_HANDLE    default: testacc.sharkgirl.pet
 *   TEST_PDS_PASSWORD  required
 *   TEST_PDS_URL       optional override for PDS base URL
 *   JETSTREAM_URL      optional override
 *   TEST_DELIVERY_PORT default: 19876
 */

import { createHmac } from 'node:crypto'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import {
	db,
	deleteWebhookRecord,
	findBacklinkWebhooks,
	findWebhooksForDid,
	getWebhookSecretToken,
	upsertWebhookRecord,
} from '../src/lib/db'
import { deliverWebhook } from '../src/lib/delivery'
import { JetstreamClient } from '../src/lib/jetstream'
import { matchWebhooks } from '../src/lib/matcher'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HANDLE = process.env.TEST_PDS_HANDLE ?? 'testacc.sharkgirl.pet'
const PASSWORD = process.env.TEST_PDS_PASSWORD
const JETSTREAM_URL = process.env.JETSTREAM_URL ?? 'wss://jetstream2.us-east.bsky.network/subscribe'
const DELIVERY_PORT = parseInt(process.env.TEST_DELIVERY_PORT ?? '19876', 10)
const EVENT_TIMEOUT_MS = 30_000

if (!PASSWORD) {
	console.error('TEST_PDS_PASSWORD is required')
	process.exit(1)
}

// ---------------------------------------------------------------------------
// PDS helpers
// ---------------------------------------------------------------------------

async function derivePdsUrl(handle: string): Promise<string> {
	if (process.env.TEST_PDS_URL) return process.env.TEST_PDS_URL.replace(/\/$/, '')
	// For subdomain handles like testacc.sharkgirl.pet, try the parent domain
	const parts = handle.split('.')
	if (parts.length >= 2) {
		const candidate = `https://${parts.slice(-2).join('.')}`
		try {
			const res = await fetch(`${candidate}/xrpc/com.atproto.server.describeServer`, {
				signal: AbortSignal.timeout(5_000),
			})
			if (res.ok) return candidate
		} catch {}
	}
	throw new Error(`Could not derive PDS URL for ${handle}. Set TEST_PDS_URL explicitly.`)
}

interface Session {
	did: string
	accessJwt: string
}

async function createSession(pdsUrl: string, identifier: string, password: string): Promise<Session> {
	const res = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier, password }),
		signal: AbortSignal.timeout(10_000),
	})
	if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`)
	return res.json() as Promise<Session>
}

async function createRecord(
	pdsUrl: string,
	jwt: string,
	repo: string,
	collection: string,
	record: Record<string, unknown>,
	rkey?: string,
): Promise<{ uri: string; cid: string }> {
	const body: Record<string, unknown> = { repo, collection, record }
	if (rkey) body.rkey = rkey
	const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	})
	if (!res.ok) throw new Error(`createRecord (${collection}) failed: ${res.status} ${await res.text()}`)
	return res.json() as Promise<{ uri: string; cid: string }>
}

async function deleteRecord(
	pdsUrl: string,
	jwt: string,
	repo: string,
	collection: string,
	rkey: string,
): Promise<void> {
	const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.deleteRecord`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
		body: JSON.stringify({ repo, collection, rkey }),
		signal: AbortSignal.timeout(10_000),
	})
	if (!res.ok) console.warn(`  deleteRecord ${collection}/${rkey}: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Local delivery server
// ---------------------------------------------------------------------------

const deliveries: Array<{ ts: number; body: unknown; signature?: string; rawBody: string }> = []
let resolveDelivery: (() => void) | null = null
let expectedDeliveries = 0

const deliveryServer = Bun.serve({
	port: DELIVERY_PORT,
	routes: {
		'/': {
			POST: async (req) => {
				const rawBody = await req.text()
				const signature = req.headers.get('x-webhook-signature') ?? undefined
				const body = JSON.parse(rawBody)
				deliveries.push({ ts: Date.now(), body, signature, rawBody })
				console.log(
					`  [delivery #${deliveries.length}] sig=${signature ?? 'none'} ${JSON.stringify(body).slice(0, 80)}`,
				)
				if (deliveries.length >= expectedDeliveries) resolveDelivery?.()
				return new Response('ok')
			},
		},
	},
	fetch: () => new Response('Not Found', { status: 404 }),
})

function waitForDeliveries(n: number): Promise<void> {
	expectedDeliveries = n
	if (deliveries.length >= n) return Promise.resolve()
	return new Promise<void>((resolve, reject) => {
		resolveDelivery = resolve
		setTimeout(
			() => reject(new Error(`Timed out waiting for ${n} deliveries (got ${deliveries.length})`)),
			EVENT_TIMEOUT_MS,
		)
	})
}

// ---------------------------------------------------------------------------
// Jetstream event handler
// ---------------------------------------------------------------------------

const testDid: { value: string } = { value: '' }
let resolveWhRegistered: (() => void) | null = null
const whRegistered = new Promise<void>((resolve) => {
	resolveWhRegistered = resolve
})

async function handleEvent(event: {
	kind: string
	did: string
	commit?: { operation: string; collection: string; rkey: string; record?: unknown; cid?: string }
}) {
	if (event.kind !== 'commit' || !event.commit) return
	const { did } = event
	const { operation: op, collection, rkey, record, cid } = event.commit
	if (op !== 'create' && op !== 'update' && op !== 'delete') return

	if (collection === 'place.wisp.v2.wh') {
		if (op === 'delete') {
			await deleteWebhookRecord(did, rkey)
		} else if (record) {
			const wh = record as WhRecord
			if (wh.scope?.aturi && wh.url) {
				await upsertWebhookRecord(did, rkey, wh)
				console.log(`  [wh registered] ${did}/${rkey} scope=${wh.scope.aturi} backlinks=${wh.scope.backlinks ?? false}`)
				resolveWhRegistered?.()
			}
		}
		return
	}

	// Only process events from the test DID to avoid noise
	if (did !== testDid.value) return

	const directCandidates = await findWebhooksForDid(did)
	const backlinkCandidates = await findBacklinkWebhooks()
	const seen = new Set(directCandidates.map((e) => `${e.ownerDid}/${e.rkey}`))
	const candidates = [...directCandidates]
	for (const entry of backlinkCandidates) {
		const k = `${entry.ownerDid}/${entry.rkey}`
		if (!seen.has(k)) {
			seen.add(k)
			candidates.push(entry)
		}
	}

	if (candidates.length === 0) return

	const matched = matchWebhooks(candidates, did, collection, rkey, op as any, record ?? null)
	for (const entry of matched) {
		await deliverWebhook(entry, did, collection, rkey, op as any, cid, record)
	}
}

// ---------------------------------------------------------------------------
// DB secret helpers (mirrors main-app logic without importing it)
// ---------------------------------------------------------------------------

async function insertTestSecret(did: string, name: string): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	const token = `wsk_${Buffer.from(bytes).toString('base64url')}`
	await db`
		INSERT INTO webhook_secrets (did, name, token, created_at)
		VALUES (${did}, ${name}, ${token}, NOW())
		ON CONFLICT (did, name) DO UPDATE SET token = EXCLUDED.token, last_rotated_at = NOW()
	`
	return token
}

async function deleteTestSecret(did: string, name: string): Promise<void> {
	await db`DELETE FROM webhook_secrets WHERE did = ${did} AND name = ${name}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const createdRecords: Array<{ collection: string; rkey: string }> = []

async function run() {
	console.log(`\n=== wisp webhook e2e ===`)
	console.log(`PDS handle : ${HANDLE}`)
	console.log(`Jetstream  : ${JETSTREAM_URL}`)
	console.log(`Delivery   : http://localhost:${DELIVERY_PORT}/`)
	console.log()

	// 1. Auth
	const pdsUrl = await derivePdsUrl(HANDLE)
	console.log(`PDS URL    : ${pdsUrl}`)
	const session = await createSession(pdsUrl, HANDLE, PASSWORD!)
	testDid.value = session.did
	console.log(`Test DID   : ${session.did}\n`)

	// 2. Jetstream
	const js = new JetstreamClient({
		url: JETSTREAM_URL,
		wantedDids: [session.did],
		onEvent: handleEvent as any,
		onConnect: () => console.log('[jetstream] connected'),
		onDisconnect: () => console.log('[jetstream] disconnected'),
		onError: (err) => console.error('[jetstream] error:', err.message),
	})
	js.start()
	// Give the WS a moment to connect before creating records
	await Bun.sleep(1_500)

	const deliveryUrl = `http://localhost:${DELIVERY_PORT}/`
	const scopeAturi = `at://${session.did}/app.bsky.feed.post`

	try {
		// 3. Create place.wisp.v2.wh record
		console.log('--- step 1: create place.wisp.v2.wh ---')
		const t0 = Date.now()
		const whRkey = `bench-wh-${Date.now()}`
		const { uri: whUri } = await createRecord(
			pdsUrl,
			session.accessJwt,
			session.did,
			'place.wisp.v2.wh',
			{
				$type: 'place.wisp.v2.wh',
				scope: { $type: 'place.wisp.v2.wh#atUri', aturi: scopeAturi, backlinks: true },
				url: deliveryUrl,
				events: ['create'],
				enabled: true,
				createdAt: new Date().toISOString(),
			},
			whRkey,
		)
		createdRecords.push({ collection: 'place.wisp.v2.wh', rkey: whRkey })
		console.log(`  created ${whUri}`)

		await Promise.race([
			whRegistered,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Timed out waiting for wh to be registered in DB')), EVENT_TIMEOUT_MS),
			),
		])
		console.log(`  registered in DB in ${Date.now() - t0}ms\n`)

		// 4. Create app.bsky.feed.post → direct match
		console.log('--- step 2: create post (expect delivery #1 — direct match) ---')
		const t1 = Date.now()
		const { uri: postUri, cid: postCid } = await createRecord(
			pdsUrl,
			session.accessJwt,
			session.did,
			'app.bsky.feed.post',
			{
				$type: 'app.bsky.feed.post',
				text: 'wisp webhook e2e test post',
				createdAt: new Date().toISOString(),
			},
		)
		const postRkey = postUri.split('/').at(-1)!
		createdRecords.push({ collection: 'app.bsky.feed.post', rkey: postRkey })
		console.log(`  created ${postUri}`)

		await waitForDeliveries(1)
		console.log(`  delivery #1 received in ${Date.now() - t1}ms\n`)

		// 5. Create app.bsky.feed.like referencing the post → backlink match
		console.log('--- step 3: like post (expect delivery #2 — backlink match) ---')
		const t2 = Date.now()
		const { uri: likeUri } = await createRecord(pdsUrl, session.accessJwt, session.did, 'app.bsky.feed.like', {
			$type: 'app.bsky.feed.like',
			subject: { uri: postUri, cid: postCid },
			createdAt: new Date().toISOString(),
		})
		const likeRkey = likeUri.split('/').at(-1)!
		createdRecords.push({ collection: 'app.bsky.feed.like', rkey: likeRkey })
		console.log(`  created ${likeUri}`)

		await waitForDeliveries(2)
		console.log(`  delivery #2 received in ${Date.now() - t2}ms\n`)

		// 6. SecretId signing test
		console.log('--- step 4: secretId signing ---')
		const secretName = `e2e-test-${Date.now()}`
		const secretToken = await insertTestSecret(session.did, secretName)
		console.log(`  inserted secret "${secretName}"`)

		// Verify getWebhookSecretToken can look it up
		const lookedUp = await getWebhookSecretToken(session.did, secretName)
		if (lookedUp !== secretToken) throw new Error(`getWebhookSecretToken mismatch: got ${lookedUp}`)
		console.log(`  getWebhookSecretToken ✓`)

		// Create a webhook with secretId, deliver manually, check signature
		const signedWhRkey = `bench-wh-signed-${Date.now()}`
		const signedWh: WhRecord = {
			$type: 'place.wisp.v2.wh',
			scope: { $type: 'place.wisp.v2.wh#atUri', aturi: `at://${session.did}/app.bsky.feed.post` },
			url: deliveryUrl,
			secretId: secretName,
			enabled: true,
			createdAt: new Date().toISOString(),
		}
		await upsertWebhookRecord(session.did, signedWhRkey, signedWh)

		// Deliver a fake event
		const beforeCount = deliveries.length
		await deliverWebhook(
			{ ownerDid: session.did, rkey: signedWhRkey, record: signedWh },
			session.did,
			'app.bsky.feed.post',
			'test-rkey',
			'create',
			undefined,
			{ text: 'signed test' },
		)

		// Wait for it
		await new Promise<void>((resolve, reject) => {
			const check = () => {
				if (deliveries.length > beforeCount) resolve()
			}
			check()
			const iv = setInterval(check, 50)
			setTimeout(() => {
				clearInterval(iv)
				reject(new Error('Timed out waiting for signed delivery'))
			}, EVENT_TIMEOUT_MS)
		})

		const signedDelivery = deliveries.at(-1)!
		if (!signedDelivery.signature) throw new Error('Expected X-Webhook-Signature header but got none')

		const expected = `sha256=${createHmac('sha256', secretToken).update(signedDelivery.rawBody).digest('hex')}`
		if (signedDelivery.signature !== expected) {
			throw new Error(`Signature mismatch:\n  got:      ${signedDelivery.signature}\n  expected: ${expected}`)
		}
		console.log(`  X-Webhook-Signature ✓  ${signedDelivery.signature.slice(0, 32)}...`)

		// Cleanup secret + wh record
		await deleteWebhookRecord(session.did, signedWhRkey)
		await deleteTestSecret(session.did, secretName)
		console.log(`  cleaned up secret + webhook record\n`)

		console.log(`=== passed ✓  total time ${Date.now() - t0}ms ===`)
	} finally {
		// Cleanup
		console.log('\n--- cleanup ---')
		for (const { collection, rkey } of createdRecords.reverse()) {
			await deleteRecord(pdsUrl, session.accessJwt, session.did, collection, rkey)
			console.log(`  deleted ${collection}/${rkey}`)
		}
		js.destroy()
		deliveryServer.stop(true)
		await db.close()
	}
}

run().catch((err) => {
	console.error('\n=== failed ✗ ===\n', err.message)
	process.exit(1)
})
