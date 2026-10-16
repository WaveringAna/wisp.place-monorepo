import { loadActiveTakedowns } from './db'
import { createTakedowns, resolveLabelerDid } from './moderation'

const labelerDid = resolveLabelerDid(process.env)

/** The process-wide takedown list; index.ts starts and stops its reloads. */
export const takedowns = createTakedowns({
	load: async () => (labelerDid ? loadActiveTakedowns(labelerDid) : []),
})
