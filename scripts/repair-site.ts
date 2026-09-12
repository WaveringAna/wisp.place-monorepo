import { main } from '../apps/firehose-service/scripts/repair-site'

try {
	await main()
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Repair failed')
	process.exitCode = 1
}
