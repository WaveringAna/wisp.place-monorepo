import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export const WATCHDOG_PROTOCOL_VERSION = 1 as const
const MAX_WATCHDOG_BUFFER = 64 * 1024
const DEFAULT_WATCHDOG_EXECUTABLE = '/usr/local/bin/firehose-watchdog'

type MaybePromise<T> = T | PromiseLike<T>

export type WatchdogState = 'ready' | 'released'

export interface WatchdogStateMessage {
	readonly version: typeof WATCHDOG_PROTOCOL_VERSION
	readonly type: 'watchdog-state'
	readonly state: WatchdogState
	readonly pid: number
}

export type WatchdogCommand =
	| {
			readonly version: typeof WATCHDOG_PROTOCOL_VERSION
			readonly type: 'hello'
			readonly supervisorPid: number
	  }
	| { readonly version: typeof WATCHDOG_PROTOCOL_VERSION; readonly type: 'release' }

export function encodeWatchdogMessage(message: WatchdogStateMessage | WatchdogCommand): string {
	return `${JSON.stringify(message)}\n`
}

export function decodeWatchdogCommand(line: string): WatchdogCommand {
	if (line.length > 4096) throw new Error('Watchdog command is too large')
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		throw new Error('Watchdog command is not valid JSON')
	}
	if (!value || typeof value !== 'object') throw new Error('Watchdog command is not an object')
	const command = value as Record<string, unknown>
	if (command.version !== WATCHDOG_PROTOCOL_VERSION || (command.type !== 'hello' && command.type !== 'release')) {
		throw new Error('Watchdog command has an invalid version or type')
	}
	if (command.type === 'hello') {
		if (!Number.isSafeInteger(command.supervisorPid) || (command.supervisorPid as number) < 1) {
			throw new Error('Watchdog hello has an invalid supervisor PID')
		}
		return {
			version: WATCHDOG_PROTOCOL_VERSION,
			type: 'hello',
			supervisorPid: command.supervisorPid as number,
		}
	}
	return { version: WATCHDOG_PROTOCOL_VERSION, type: 'release' }
}

export function decodeWatchdogState(line: string): WatchdogStateMessage {
	if (line.length > 4096) throw new Error('Watchdog state is too large')
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		throw new Error('Watchdog state is not valid JSON')
	}
	if (!value || typeof value !== 'object') throw new Error('Watchdog state is not an object')
	const state = value as Record<string, unknown>
	if (
		state.version !== WATCHDOG_PROTOCOL_VERSION ||
		state.type !== 'watchdog-state' ||
		(state.state !== 'ready' && state.state !== 'released') ||
		!Number.isSafeInteger(state.pid) ||
		(state.pid as number) < 1
	) {
		throw new Error('Watchdog state has an invalid shape')
	}
	return {
		version: WATCHDOG_PROTOCOL_VERSION,
		type: 'watchdog-state',
		state: state.state as WatchdogState,
		pid: state.pid as number,
	}
}

export type WorkerKiller = (pid: number) => void

/** The watchdog's only authority action when its supervisor pipe reaches EOF. */
export function killWorkerOnSupervisorLoss(
	workerPid: number,
	kill: WorkerKiller = (pid) => process.kill(pid, 'SIGKILL'),
): void {
	if (!Number.isSafeInteger(workerPid) || workerPid < 1) return
	try {
		kill(workerPid)
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
		// A worker that cannot be killed is still unsafe. Let the watchdog exit
		// nonzero; its container supervisor will restart the service.
	}
}

export interface SupervisorWatchdog {
	start(): Promise<void>
	stop(): Promise<void>
	/** Close the supervisor pipe. The watchdog treats EOF as a worker-fatal event. */
	close(): MaybePromise<void>
	onFailure?(handler: (error: Error) => void): void
}

export interface WatchdogProcessLike {
	readonly stdin: {
		write(data: string): boolean
		end(): void
	}
	readonly stdout: {
		setEncoding(encoding: string): unknown
		on(event: string, listener: (...args: unknown[]) => void): unknown
	}
	on(event: string, listener: (...args: unknown[]) => void): unknown
}

export type WatchdogProcessSpawner = (
	file: string,
	args: readonly string[],
	options: {
		stdio: ['pipe', 'pipe', 'inherit']
		env: NodeJS.ProcessEnv
	},
) => WatchdogProcessLike

export interface ProcessWatchdogOptions {
	readonly executable?: string
	readonly workerPid: number
	readonly supervisorPid?: number
	readonly environment?: NodeJS.ProcessEnv
	readonly spawn?: WatchdogProcessSpawner
}

/** Worker-killing watchdog process owned by the leadership supervisor. */
export class ProcessWatchdog implements SupervisorWatchdog {
	private readonly executable: string
	private readonly workerPid: number
	private readonly supervisorPid: number
	private readonly environment: NodeJS.ProcessEnv
	private readonly spawnProcess: WatchdogProcessSpawner
	private child: WatchdogProcessLike | null = null
	private buffer = ''
	private expectedStop = false
	private started = false
	private readyResolve: (() => void) | null = null
	private readyReject: ((error: Error) => void) | null = null
	private stopResolve: (() => void) | null = null
	private stopReject: ((error: Error) => void) | null = null
	private failureHandler: ((error: Error) => void) | null = null

	constructor(options: ProcessWatchdogOptions) {
		if (!Number.isSafeInteger(options.workerPid) || options.workerPid < 1)
			throw new Error('Invalid watchdog worker PID')
		this.executable = options.executable ?? process.env.FIREHOSE_WATCHDOG_PATH ?? DEFAULT_WATCHDOG_EXECUTABLE
		this.workerPid = options.workerPid
		this.supervisorPid = options.supervisorPid ?? process.pid
		this.environment = options.environment ?? process.env
		this.spawnProcess =
			options.spawn ??
			((file, args, spawnOptions) => spawn(file, args, spawnOptions) as unknown as ChildProcessWithoutNullStreams)
	}

	onFailure(handler: (error: Error) => void): void {
		this.failureHandler = handler
	}

	start(): Promise<void> {
		if (this.started) return Promise.resolve()
		this.started = true
		return new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve
			this.readyReject = reject
			let child: WatchdogProcessLike
			try {
				child = this.spawnProcess(
					this.executable,
					[`--worker-pid=${this.workerPid}`, `--supervisor-pid=${this.supervisorPid}`],
					{
						stdio: ['pipe', 'pipe', 'inherit'],
						env: {
							...this.environment,
							WATCHDOG_SUPERVISOR_PID: String(this.supervisorPid),
						},
					},
				)
			} catch (error) {
				this.started = false
				reject(error instanceof Error ? error : new Error('Failed to start watchdog'))
				return
			}
			this.child = child
			child.stdout.setEncoding('utf8')
			child.stdout.on('data', (chunk: unknown) => this.consumeOutput(String(chunk)))
			child.stdout.on('error', () => this.fail(new Error('Watchdog state pipe failed')))
			child.on('error', (error: unknown) => this.fail(error instanceof Error ? error : new Error('Watchdog failed')))
			child.on('close', (code: unknown) => {
				if (this.expectedStop) return
				this.fail(new Error(`Watchdog exited unexpectedly (${String(code)})`))
			})
			try {
				const accepted = child.stdin.write(
					encodeWatchdogMessage({
						version: WATCHDOG_PROTOCOL_VERSION,
						type: 'hello',
						supervisorPid: this.supervisorPid,
					}),
				)
				if (!accepted) throw new Error('Watchdog command pipe backpressure')
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error('Watchdog command pipe failed'))
				reject(error instanceof Error ? error : new Error('Watchdog command pipe failed'))
			}
		})
	}

	stop(): Promise<void> {
		if (!this.child || this.expectedStop) return Promise.resolve()
		this.expectedStop = true
		return new Promise<void>((resolve, reject) => {
			this.stopResolve = resolve
			this.stopReject = reject
			try {
				const accepted = this.child?.stdin.write(encodeWatchdogMessage({ version: 1, type: 'release' }))
				if (!accepted) throw new Error('Watchdog command pipe backpressure')
			} catch (error) {
				reject(error instanceof Error ? error : new Error('Watchdog release failed'))
			}
		})
	}

	close(): void {
		const child = this.child
		if (!child) return
		this.expectedStop = true
		try {
			child.stdin.end()
		} catch {
			// The supervisor is already on a fatal path. The watchdog may already
			// have observed EOF and killed the worker.
		}
	}

	private consumeOutput(chunk: string): void {
		this.buffer += chunk
		if (this.buffer.length > MAX_WATCHDOG_BUFFER) {
			this.fail(new Error('Watchdog state exceeded limit'))
			return
		}
		while (true) {
			const newline = this.buffer.indexOf('\n')
			if (newline < 0) return
			const line = this.buffer.slice(0, newline).trim()
			this.buffer = this.buffer.slice(newline + 1)
			try {
				const message = decodeWatchdogState(line)
				if (message.state === 'ready') {
					this.readyResolve?.()
					this.readyResolve = null
					this.readyReject = null
				} else {
					this.stopResolve?.()
					this.stopResolve = null
					this.stopReject = null
				}
			} catch {
				this.fail(new Error('Watchdog sent malformed state'))
				return
			}
		}
	}

	private fail(error: Error): void {
		this.readyReject?.(error)
		this.readyResolve = null
		this.readyReject = null
		this.stopReject?.(error)
		this.stopResolve = null
		this.stopReject = null
		if (!this.expectedStop) this.failureHandler?.(error)
	}
}

export function createProcessWatchdog(options: ProcessWatchdogOptions): ProcessWatchdog {
	return new ProcessWatchdog(options)
}
