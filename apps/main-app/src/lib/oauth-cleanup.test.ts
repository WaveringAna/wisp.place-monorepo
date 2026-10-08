import { describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { deleteExpiredOAuthRows } from './oauth-cleanup'

/** Answers each DELETE like Bun SQL does without RETURNING: no rows, an affected count. */
const fakeSql = (counts: number[]) => {
	const queries: string[] = []
	const sql = (strings: TemplateStringsArray) => {
		queries.push(strings.join('?'))
		return Promise.resolve(Object.assign([], { count: counts[queries.length - 1] ?? 0 }))
	}
	return { sql: sql as unknown as SQL, queries }
}

const recordingLogger = () => {
	const lines: Array<{ level: string; message: string }> = []
	return {
		lines,
		log: {
			info: (message: string) => lines.push({ level: 'info', message }),
			debug: (message: string) => lines.push({ level: 'debug', message }),
			error: (message: string) => lines.push({ level: 'error', message }),
		},
	}
}

describe('expired OAuth cleanup', () => {
	test('logs at debug when nothing expired', async () => {
		const { sql } = fakeSql([0, 0])
		const { lines, log } = recordingLogger()

		expect(await deleteExpiredOAuthRows(sql, log, 1_800_000_000)).toEqual({ sessions: 0, states: 0 })
		expect(lines).toEqual([{ level: 'debug', message: '[Cleanup] Deleted 0 expired sessions and 0 expired states' }])
	})

	test('logs at info with the affected row counts when rows were deleted', async () => {
		const { sql, queries } = fakeSql([2, 5])
		const { lines, log } = recordingLogger()

		expect(await deleteExpiredOAuthRows(sql, log, 1_800_000_000)).toEqual({ sessions: 2, states: 5 })
		expect(queries).toHaveLength(2)
		expect(lines).toEqual([{ level: 'info', message: '[Cleanup] Deleted 2 expired sessions and 5 expired states' }])
	})

	test('logs an error and reports nothing deleted when a delete fails', async () => {
		const sql = (() => Promise.reject(new Error('connection reset'))) as unknown as SQL
		const { lines, log } = recordingLogger()

		expect(await deleteExpiredOAuthRows(sql, log)).toEqual({ sessions: 0, states: 0 })
		expect(lines.map((line) => line.level)).toEqual(['error'])
	})
})
