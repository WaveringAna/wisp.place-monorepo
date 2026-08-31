/** Versioned newline-delimited protocol between the firehose worker and the leadership supervisor. */
export const SUPERVISOR_PROTOCOL_VERSION = 1 as const

export type SupervisorState = 'standby' | 'acquired' | 'releasing' | 'released' | 'fatal'

export interface SupervisorStateMessage {
	readonly version: typeof SUPERVISOR_PROTOCOL_VERSION
	readonly type: 'state'
	readonly state: SupervisorState
	readonly pid: number
	readonly epoch?: number
	readonly reason?: string
}

export type SupervisorCommand =
	| {
			readonly version: typeof SUPERVISOR_PROTOCOL_VERSION
			readonly type: 'hello'
			readonly parentPid: number
	  }
	| {
			readonly version: typeof SUPERVISOR_PROTOCOL_VERSION
			readonly type: 'release'
	  }

export function encodeSupervisorMessage(message: SupervisorStateMessage | SupervisorCommand): string {
	return `${JSON.stringify(message)}\n`
}

/** Parse one protocol line without accepting arbitrary objects or oversized payloads. */
export function decodeSupervisorCommand(line: string): SupervisorCommand {
	if (line.length > 4096) throw new Error('Supervisor command is too large')
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		throw new Error('Supervisor command is not valid JSON')
	}
	if (!value || typeof value !== 'object') throw new Error('Supervisor command is not an object')
	const command = value as Record<string, unknown>
	if (command.version !== SUPERVISOR_PROTOCOL_VERSION || (command.type !== 'hello' && command.type !== 'release')) {
		throw new Error('Supervisor command has an invalid version or type')
	}
	if (command.type === 'hello') {
		if (!Number.isSafeInteger(command.parentPid) || (command.parentPid as number) <= 0) {
			throw new Error('Supervisor hello has an invalid parent PID')
		}
		return {
			version: SUPERVISOR_PROTOCOL_VERSION,
			type: 'hello',
			parentPid: command.parentPid as number,
		}
	}
	return { version: SUPERVISOR_PROTOCOL_VERSION, type: 'release' }
}

export function decodeSupervisorState(line: string): SupervisorStateMessage {
	if (line.length > 4096) throw new Error('Supervisor state is too large')
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		throw new Error('Supervisor state is not valid JSON')
	}
	if (!value || typeof value !== 'object') throw new Error('Supervisor state is not an object')
	const state = value as Record<string, unknown>
	if (
		state.version !== SUPERVISOR_PROTOCOL_VERSION ||
		state.type !== 'state' ||
		!['standby', 'acquired', 'releasing', 'released', 'fatal'].includes(state.state as string) ||
		!Number.isSafeInteger(state.pid) ||
		(state.pid as number) <= 0
	) {
		throw new Error('Supervisor state has an invalid shape')
	}
	if (state.epoch !== undefined && (!Number.isSafeInteger(state.epoch) || (state.epoch as number) < 1)) {
		throw new Error('Supervisor state has an invalid epoch')
	}
	if (state.reason !== undefined && (typeof state.reason !== 'string' || state.reason.length > 512)) {
		throw new Error('Supervisor state has an invalid reason')
	}
	if (state.state === 'acquired' && state.epoch === undefined) throw new Error('Acquired state has no epoch')
	return {
		version: SUPERVISOR_PROTOCOL_VERSION,
		type: 'state',
		state: state.state as SupervisorState,
		pid: state.pid as number,
		...(state.epoch !== undefined ? { epoch: state.epoch as number } : {}),
		...(typeof state.reason === 'string' ? { reason: state.reason } : {}),
	}
}
