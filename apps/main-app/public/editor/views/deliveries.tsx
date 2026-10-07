import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { WebhookDelivery } from '../api'
import { timeAgo } from '../format'
import { keys, useDeliveries } from '../queries'
import { Button, Empty, Input, Notice, Section, Segmented, Sheet, SkeletonRows, Status } from '../ui'

type Column = 'status' | 'eventKind' | 'eventCollection' | 'url' | 'deliveredAt'
type Direction = 'ascending' | 'descending'
type StatusFilter = 'all' | WebhookDelivery['status']

const COLUMNS: { column: Column; label: string; className?: string }[] = [
	{ column: 'status', label: 'status', className: 'w-24' },
	{ column: 'eventKind', label: 'event', className: 'w-20' },
	{ column: 'eventCollection', label: 'collection' },
	{ column: 'url', label: 'endpoint', className: 'max-md:hidden' },
	{ column: 'deliveredAt', label: 'when', className: 'w-24' },
]

const STATUSES = [
	{ value: 'all', label: 'all' },
	{ value: 'ok', label: 'ok' },
	{ value: 'failed', label: 'failed' },
] as const

interface View {
	query: string
	status: StatusFilter
	column: Column
	direction: Direction
}

export function visibleDeliveries(deliveries: readonly WebhookDelivery[], view: View): WebhookDelivery[] {
	const query = view.query.trim().toLowerCase()
	const sign = view.direction === 'ascending' ? 1 : -1
	return deliveries
		.filter((delivery) => view.status === 'all' || delivery.status === view.status)
		.filter(
			(delivery) =>
				!query || delivery.eventCollection.toLowerCase().includes(query) || delivery.url.toLowerCase().includes(query),
		)
		.sort((a, b) => sign * a[view.column].localeCompare(b[view.column]))
}

export function Deliveries() {
	const deliveries = useDeliveries()
	const client = useQueryClient()
	const [view, setView] = useState<View>({ query: '', status: 'all', column: 'deliveredAt', direction: 'descending' })
	const all = deliveries.data ?? []
	const shown = visibleDeliveries(all, view)

	// Clicking the sorted column flips it; a new column starts newest-first for time, a→z otherwise.
	const sortBy = (column: Column) =>
		setView((previous) => {
			const flipped: Direction = previous.direction === 'ascending' ? 'descending' : 'ascending'
			const fresh: Direction = column === 'deliveredAt' ? 'descending' : 'ascending'
			return { ...previous, column, direction: previous.column === column ? flipped : fresh }
		})

	return (
		<Section
			title="recent deliveries"
			meta={deliveries.data && (shown.length === all.length ? `${all.length}` : `${shown.length} of ${all.length}`)}
			actions={
				<Button
					variant="ghost"
					busy={deliveries.isFetching}
					onClick={() => client.invalidateQueries({ queryKey: keys.deliveries })}
				>
					refresh
				</Button>
			}
		>
			{deliveries.isPending && <SkeletonRows count={3} />}
			{deliveries.isError && <Notice tone="bad">could not load deliveries: {deliveries.error.message}</Notice>}
			{deliveries.isSuccess && all.length === 0 && (
				<Empty>no deliveries yet, they show up here once a webhook fires</Empty>
			)}
			{all.length > 0 && (
				<>
					<div className="my-3 flex flex-wrap items-center gap-3">
						<Input
							aria-label="filter by collection or endpoint"
							placeholder="filter by collection or endpoint"
							value={view.query}
							onChange={(event) => setView((previous) => ({ ...previous, query: event.target.value }))}
							className="max-w-xs"
						/>
						<Segmented
							label="delivery status"
							options={STATUSES}
							value={view.status}
							onChange={(status) => setView((previous) => ({ ...previous, status }))}
						/>
					</div>
					<Sheet
						columns={COLUMNS.map(({ column, label, className }) => ({
							name: column,
							className,
							align: column === 'deliveredAt' ? 'right' : 'left',
							sort: view.column === column ? view.direction : undefined,
							label: (
								<button type="button" onClick={() => sortBy(column)} className="hover:text-ink">
									{label}
									{view.column === column && (view.direction === 'ascending' ? ' ↑' : ' ↓')}
								</button>
							),
						}))}
						foot={shown.length === 0 ? 'nothing matches those filters' : undefined}
					>
						{shown.map((delivery) => (
							<tr key={`${delivery.rkey}:${delivery.eventRkey}:${delivery.deliveredAt}`}>
								<td>{delivery.status === 'ok' ? <Status tone="ok">ok</Status> : <Status tone="bad">failed</Status>}</td>
								<td>{delivery.eventKind}</td>
								<td className="max-w-0 truncate" title={delivery.eventCollection}>
									{delivery.eventCollection || '·'}
								</td>
								<td className="max-w-0 truncate max-md:hidden" title={delivery.url}>
									{delivery.url}
								</td>
								<td className="num whitespace-nowrap text-xs">{timeAgo(delivery.deliveredAt)}</td>
							</tr>
						))}
					</Sheet>
				</>
			)}
		</Section>
	)
}
