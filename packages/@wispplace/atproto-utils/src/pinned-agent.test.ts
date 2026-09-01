import { afterEach, describe, expect, test } from 'bun:test'
import { closePinnedKeepAliveAgents, type PinnedAgentAddress, pinnedKeepAliveAgent } from './pinned-agent'

const address = (value: string, family: 4 | 6 = 4): PinnedAgentAddress => ({ address: value, family })

afterEach(() => {
	closePinnedKeepAliveAgents()
})

describe('pinnedKeepAliveAgent', () => {
	test('reuses one agent for the same origin and validated address', () => {
		const url = new URL('https://pds.example/xrpc/com.atproto.server.getSession')
		const first = pinnedKeepAliveAgent(url, address('203.0.113.10'))
		const second = pinnedKeepAliveAgent(new URL('https://pds.example/oauth/token'), address('203.0.113.10'))

		expect(second).toBe(first)
	})

	test('keeps sockets alive', () => {
		const agent = pinnedKeepAliveAgent(new URL('https://pds.example/'), address('203.0.113.10'))
		expect((agent as unknown as { options: { keepAlive?: boolean } }).options.keepAlive).toBe(true)
	})

	test('never shares an agent across two addresses for one hostname', () => {
		// Node's socket pool name is built from host, port and family, never from
		// the lookup hook. Sharing here would hand out a socket connected to an
		// address the caller did not pin.
		const url = new URL('https://pds.example/')
		const first = pinnedKeepAliveAgent(url, address('203.0.113.10'))
		const second = pinnedKeepAliveAgent(url, address('198.51.100.7'))

		expect(second).not.toBe(first)
	})

	test('separates agents by address family, port, protocol and host', () => {
		const base = pinnedKeepAliveAgent(new URL('https://pds.example/'), address('203.0.113.10'))

		expect(pinnedKeepAliveAgent(new URL('https://pds.example/'), address('203.0.113.10', 6))).not.toBe(base)
		expect(pinnedKeepAliveAgent(new URL('https://pds.example:8443/'), address('203.0.113.10'))).not.toBe(base)
		expect(pinnedKeepAliveAgent(new URL('http://pds.example/'), address('203.0.113.10'))).not.toBe(base)
		expect(pinnedKeepAliveAgent(new URL('https://other.example/'), address('203.0.113.10'))).not.toBe(base)
	})

	test('matches the default port whether or not the URL states it', () => {
		const implicit = pinnedKeepAliveAgent(new URL('https://pds.example/'), address('203.0.113.10'))
		// URL drops a default port, so both forms have to land on one agent.
		const explicit = pinnedKeepAliveAgent(new URL('https://pds.example:443/'), address('203.0.113.10'))

		expect(explicit).toBe(implicit)
	})

	test('closing the pool drops every agent', () => {
		const url = new URL('https://pds.example/')
		const first = pinnedKeepAliveAgent(url, address('203.0.113.10'))
		closePinnedKeepAliveAgents()

		expect(pinnedKeepAliveAgent(url, address('203.0.113.10'))).not.toBe(first)
	})

	test('bounds how many destinations stay pooled', () => {
		const url = new URL('https://pds.example/')
		const first = pinnedKeepAliveAgent(url, address('203.0.113.1'))
		for (let i = 0; i < 300; i++) {
			pinnedKeepAliveAgent(url, address(`198.51.${Math.floor(i / 254)}.${i % 254}`))
		}

		expect(pinnedKeepAliveAgent(url, address('203.0.113.1'))).not.toBe(first)
	})
})
