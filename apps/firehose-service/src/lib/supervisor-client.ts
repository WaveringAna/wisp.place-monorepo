import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { decodeSupervisorState, encodeSupervisorMessage, type SupervisorStateMessage } from './supervisor-protocol'

export interface SupervisorProcessLike {
	readonly stdin: { write(data: string): boolean; once(event: string, listener: (...args: unknown[]) => void): unknown }
	readonly stdout: {
		setEncoding(encoding: string): unknown
		on(event: string, listener: (...args: unknown[]) => void): unknown
	}
	on(event: string, listener: (...args: unknown[]) => void): unknown
	once(event: string, listener: (...args: unknown[]) => void): unknown
}

export type SupervisorProcessSpawner = (
	file: string,
	args: readonly string[],
	options: {
		stdio: ['pipe', 'pipe', 'inherit']
		env: NodeJS.ProcessEnv
	},
) => SupervisorProcessLike

export interface SupervisorClientOptions {
	readonly executable?: string
	readonly parentPid?: number
	readonly environment?: NodeJS.ProcessEnv
	readonly spawn?: SupervisorProcessSpawner
	readonly onState?: (state: SupervisorStateMessage) => void
	readonly onFailure?: (error: Error) => void
}

const DEFAULT_SUPERVISOR_EXECUTABLE = '/usr/local/bin/firehose-supervisor'
const MAX_STATE_BUFFER = 64 * 1024

/** Worker-side client. It never owns or renews the Redis/PG authority itself. */
export class SupervisorClient {
	private readonly executable: string
	private readonly parentPid: number
	private readonly environment: NodeJS.ProcessEnv
	private readonly spawnProcess: SupervisorProcessSpawner
	private readonly onState?: (state: SupervisorStateMessage) => void
	private readonly onFailure?: (error: Error) => void
	private child: SupervisorProcessLike | null = null
	private inputBuffer = ''
	private stateMessage: SupervisorStateMessage | null = null
	private startPromise: Promise<void> | null = null
	private releasePromise: Promise<void> | null = null
	private acquiredResolve: ((state: SupervisorStateMessage) => void) | null = null
	private acquiredReject: ((error: Error) => void) | null = null
	private releaseResolve: (() => void) | null = null
	private releaseReject: ((error: Error) => void) | null = null
	private failureReported = false

	constructor(options: SupervisorClientOptions = {}) {
		this.executable = options.executable ?? process.env.FIREHOSE_SUPERVISOR_PATH ?? DEFAULT_SUPERVISOR_EXECUTABLE
		this.parentPid = options.parentPid ?? process.pid
		this.environment = options.environment ?? process.env
		this.spawnProcess =
			options.spawn ??
			((file, args, spawnOptions) => spawn(file, args, spawnOptions) as unknown as ChildProcessWithoutNullStreams)
		this.onState = options.onState
		this.onFailure = options.onFailure
	}

	get state(): SupervisorStateMessage | null {
		return this.stateMessage
	}

	get process(): SupervisorProcessLike | null {
		return this.child
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise
		this.startPromise = new Promise<void>((resolve, reject) => {
			let child: SupervisorProcessLike
			try {
				child = this.spawnProcess(this.executable, [`--parent-pid=${this.parentPid}`], {
					stdio: ['pipe', 'pipe', 'inherit'],
					env: {
						...this.environment,
						SUPERVISOR_PARENT_PID: String(this.parentPid),
					},
				})
			} catch (error) {
				reject(error instanceof Error ? error : new Error('Failed to start leadership supervisor'))
				return
			}
			this.child = child
			child.stdout.setEncoding('utf8')
			child.stdout.on('data', (chunk: unknown) => this.consumeOutput(String(chunk)))
			child.stdout.on('error', () => this.fail(new Error('Leadership supervisor output pipe failed')))
			child.on('error', (error: unknown) =>
				this.fail(error instanceof Error ? error : new Error('Leadership supervisor failed')),
			)
			child.on('close', (code: unknown) => {
				if (this.stateMessage?.state === 'released') return
				this.fail(new Error(`Leadership supervisor exited unexpectedly (${String(code)})`))
			})
			try {
				const accepted = child.stdin.write(
					encodeSupervisorMessage({ version: 1, type: 'hello', parentPid: this.parentPid }),
				)
				if (!accepted) throw new Error('Leadership supervisor command pipe backpressure')
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error('Leadership supervisor command pipe failed'))
				reject(error instanceof Error ? error : new Error('Leadership supervisor command pipe failed'))
				return
			}
			resolve()
		})
		return this.startPromise
	}

	waitForAcquired(signal?: AbortSignal): Promise<SupervisorStateMessage> {
		if (this.stateMessage?.state === 'acquired') return Promise.resolve(this.stateMessage)
		if (this.stateMessage?.state === 'fatal')
			return Promise.reject(new Error(this.stateMessage.reason ?? 'Supervisor failed'))
		return new Promise<SupervisorStateMessage>((resolve, reject) => {
			this.acquiredResolve = resolve
			this.acquiredReject = reject
			if (signal) {
				if (signal.aborted) {
					reject(new Error('Leadership supervisor wait aborted'))
					return
				}
				signal.addEventListener('abort', () => reject(new Error('Leadership supervisor wait aborted')), { once: true })
			}
		})
	}

	/** Send release only after the worker has stopped all firehose/cursor activity. */
	requestRelease(): Promise<void> {
		if (this.stateMessage?.state === 'released') return Promise.resolve()
		if (this.releasePromise) return this.releasePromise
		this.releasePromise = new Promise<void>((resolve, reject) => {
			this.releaseResolve = resolve
			this.releaseReject = reject
			const child = this.child
			if (!child) {
				reject(new Error('Leadership supervisor is not running'))
				return
			}
			try {
				const accepted = child.stdin.write(encodeSupervisorMessage({ version: 1, type: 'release' }))
				if (!accepted) throw new Error('Leadership supervisor command pipe backpressure')
			} catch (error) {
				reject(error instanceof Error ? error : new Error('Leadership supervisor release failed'))
			}
		})
		return this.releasePromise
	}

	private consumeOutput(chunk: string): void {
		this.inputBuffer += chunk
		if (this.inputBuffer.length > MAX_STATE_BUFFER) {
			this.fail(new Error('Leadership supervisor state exceeded limit'))
			return
		}
		while (true) {
			const newline = this.inputBuffer.indexOf('\n')
			if (newline < 0) return
			const line = this.inputBuffer.slice(0, newline).trim()
			this.inputBuffer = this.inputBuffer.slice(newline + 1)
			if (!line) {
				this.fail(new Error('Leadership supervisor sent an empty state'))
				return
			}
			let message: SupervisorStateMessage
			try {
				message = decodeSupervisorState(line)
			} catch {
				this.fail(new Error('Leadership supervisor sent malformed state'))
				return
			}
			this.stateMessage = message
			this.onState?.(message)
			if (message.state === 'acquired') {
				this.acquiredResolve?.(message)
				this.acquiredResolve = null
				this.acquiredReject = null
			}
			if (message.state === 'fatal') {
				this.acquiredReject?.(new Error(message.reason ?? 'Leadership supervisor failed'))
				this.acquiredResolve = null
				this.acquiredReject = null
				this.releaseReject?.(new Error(message.reason ?? 'Leadership supervisor failed'))
				this.releaseResolve = null
				this.releaseReject = null
			}
			if (message.state === 'released') {
				this.releaseResolve?.()
				this.releaseResolve = null
				this.releaseReject = null
			}
		}
	}

	private fail(error: Error): void {
		this.acquiredReject?.(error)
		this.acquiredResolve = null
		this.acquiredReject = null
		this.releaseReject?.(error)
		this.releaseResolve = null
		this.releaseReject = null
		if (!this.failureReported) {
			this.failureReported = true
			this.onFailure?.(error)
		}
	}
}

export function createSupervisorClient(options: SupervisorClientOptions = {}): SupervisorClient {
	return new SupervisorClient(options)
}
