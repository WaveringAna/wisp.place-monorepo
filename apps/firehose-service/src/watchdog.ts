#!/usr/bin/env bun

import {
	decodeWatchdogCommand,
	encodeWatchdogMessage,
	killWorkerOnSupervisorLoss,
	WATCHDOG_PROTOCOL_VERSION,
	type WatchdogStateMessage,
} from './lib/watchdog'

const MAX_IPC_BUFFER = 64 * 1024
let inputBuffer = ''
const outputClosed = false
let expectedRelease = false
let helloReceived = false
let workerPid: number | undefined
let supervisorPid: number | undefined

function parsedPid(flag: string): number | undefined {
	const value = process.argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1)
	if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
	const pid = Number(value)
	return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined
}

function parsedEnvironmentPid(name: string): number | undefined {
	const value = process.env[name]
	if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
	const pid = Number(value)
	return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined
}

function killWorker(): void {
	if (workerPid !== undefined) killWorkerOnSupervisorLoss(workerPid)
}

function writeState(state: WatchdogStateMessage['state']): void {
	if (outputClosed) return
	const accepted = process.stdout.write(
		encodeWatchdogMessage({
			version: WATCHDOG_PROTOCOL_VERSION,
			type: 'watchdog-state',
			state,
			pid: process.pid,
		}),
	)
	if (!accepted) throw new Error('Watchdog state pipe backpressure')
}

function fail(): void {
	if (expectedRelease) return
	killWorker()
	process.exitCode = 1
	process.stdin.pause()
}

function consumeInput(chunk: string): void {
	inputBuffer += chunk
	if (inputBuffer.length > MAX_IPC_BUFFER) {
		fail()
		return
	}
	while (true) {
		const newline = inputBuffer.indexOf('\n')
		if (newline < 0) return
		const line = inputBuffer.slice(0, newline).trim()
		inputBuffer = inputBuffer.slice(newline + 1)
		try {
			const command = decodeWatchdogCommand(line)
			if (command.type === 'hello') {
				if (supervisorPid === undefined || command.supervisorPid !== supervisorPid)
					throw new Error('Supervisor PID changed')
				helloReceived = true
				writeState('ready')
			} else {
				if (!helloReceived) throw new Error('Watchdog release arrived before handshake')
				writeState('released')
				expectedRelease = true
				process.exitCode = 0
				process.stdin.pause()
			}
		} catch {
			fail()
			return
		}
	}
}

function main(): void {
	workerPid = parsedPid('--worker-pid')
	supervisorPid = parsedPid('--supervisor-pid') ?? parsedEnvironmentPid('WATCHDOG_SUPERVISOR_PID')
	if (workerPid === undefined || supervisorPid === undefined) {
		fail()
		return
	}
	process.stdin.setEncoding('utf8')
	process.stdin.on('data', consumeInput)
	process.stdin.on('end', () => {
		if (!expectedRelease) fail()
	})
	process.stdin.on('error', fail)
	process.stdout.on('error', fail)
	process.stdout.on('close', fail)
	process.on('SIGTERM', fail)
	process.on('SIGINT', fail)
}

main()
