#!/usr/bin/env bun

import { createProductionSupervisor } from './lib/leadership-supervisor'
import { resolveSupervisorConfig } from './lib/supervisor-config'
import {
	decodeSupervisorCommand,
	encodeSupervisorMessage,
	type SupervisorStateMessage,
} from './lib/supervisor-protocol'

const MAX_IPC_BUFFER = 64 * 1024
let outputClosed = false
let inputBuffer = ''
let supervisor: ReturnType<typeof createProductionSupervisor> | null = null

function writeState(message: SupervisorStateMessage): void {
	if (outputClosed) throw new Error('Supervisor state pipe is closed')
	const accepted = process.stdout.write(encodeSupervisorMessage(message))
	if (!accepted) throw new Error('Supervisor state pipe backpressure')
}

async function failFromIpc(reason: string): Promise<void> {
	if (supervisor) await supervisor.failClosed(reason)
}

function consumeInput(chunk: string): void {
	inputBuffer += chunk
	if (inputBuffer.length > MAX_IPC_BUFFER) {
		void failFromIpc('parent IPC command buffer exceeded limit')
		return
	}
	while (true) {
		const newline = inputBuffer.indexOf('\n')
		if (newline < 0) return
		const line = inputBuffer.slice(0, newline).trim()
		inputBuffer = inputBuffer.slice(newline + 1)
		if (!line) {
			void failFromIpc('empty parent IPC command')
			return
		}
		try {
			const command = decodeSupervisorCommand(line)
			void supervisor?.handleCommand(command).catch(() => failFromIpc('parent IPC command failed'))
		} catch {
			void failFromIpc('malformed parent IPC command')
			return
		}
	}
}

function parentPidFromEnvironment(): number | undefined {
	const argument = process.argv.find((value) => value.startsWith('--parent-pid='))?.slice('--parent-pid='.length)
	const value = argument ?? process.env.SUPERVISOR_PARENT_PID
	if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
	const pid = Number(value)
	return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined
}

function killParentForStartupFailure(): void {
	const pid = parentPidFromEnvironment()
	if (pid === undefined) return
	try {
		process.kill(pid, 'SIGKILL')
	} catch {
		// The parent may already have exited. Startup still exits nonzero.
	}
}

async function main(): Promise<void> {
	const config = resolveSupervisorConfig(process.env, process.argv)
	process.stdin.setEncoding('utf8')
	process.stdin.on('data', consumeInput)
	process.stdin.on('end', () => {
		void failFromIpc('parent IPC pipe closed')
	})
	process.stdin.on('error', () => {
		void failFromIpc('parent IPC pipe error')
	})
	process.stdout.on('error', () => {
		outputClosed = true
		void failFromIpc('parent state pipe closed')
	})
	process.stdout.on('close', () => {
		outputClosed = true
		void failFromIpc('parent state pipe closed')
	})

	supervisor = createProductionSupervisor(config, writeState)
	process.on('SIGTERM', () => {
		void supervisor?.failClosed('supervisor received SIGTERM')
	})
	process.on('SIGINT', () => {
		void supervisor?.failClosed('supervisor received SIGINT')
	})
	const result = await supervisor.run()
	process.exitCode = result.exitCode
	// Stop reading the parent pipe and let Bun flush the state frame before exit.
	process.stdin.pause()
}

main().catch(() => {
	killParentForStartupFailure()
	process.exitCode = 1
	process.exit(1)
})
