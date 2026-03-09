import type { Agent } from '@atproto/api'
import { schemas } from '@wispplace/lexicons/lexicons'
import { parseServiceDid, WISP_PROXY_SERVICE_ID } from './wisp-service.ts'

function registerWispLexicons(agent: Agent): void {
	for (const schema of schemas) {
		if (!agent.lex.get(schema.id)) {
			agent.lex.add(schema)
		}
	}
}

export interface WispXrpcCallOptions {
	serviceDid?: string
	params?: Record<string, any>
	data?: unknown
}

export async function callWispXrpc<T>(agent: Agent, nsid: string, options: WispXrpcCallOptions = {}): Promise<T> {
	const serviceDid = parseServiceDid(options.serviceDid)
	const proxiedAgent = agent.withProxy(WISP_PROXY_SERVICE_ID, serviceDid)

	registerWispLexicons(proxiedAgent)

	const response = await proxiedAgent.call(nsid, options.params, options.data)
	return response.data as T
}
