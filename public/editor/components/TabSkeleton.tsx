import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from '@public/components/ui/card'

// Shimmer animation for skeleton loading
const Shimmer = () => (
	<div className="animate-pulse">
		<div className="h-4 bg-muted rounded w-3/4 mb-2"></div>
		<div className="h-4 bg-muted rounded w-1/2"></div>
	</div>
)

const SkeletonLine = ({ className = '' }: { className?: string }) => (
	<div className={`animate-pulse bg-muted rounded ${className}`}></div>
)

export function TabSkeleton() {
	return (
		<div className="space-y-4 min-h-[400px]">
			<Card>
				<CardHeader>
					<div className="space-y-2">
						<SkeletonLine className="h-6 w-1/3" />
						<SkeletonLine className="h-4 w-2/3" />
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Skeleton content items */}
					<div className="p-4 border border-border rounded-lg">
						<SkeletonLine className="h-5 w-1/2 mb-3" />
						<SkeletonLine className="h-4 w-3/4 mb-2" />
						<SkeletonLine className="h-4 w-2/3" />
					</div>
					<div className="p-4 border border-border rounded-lg">
						<SkeletonLine className="h-5 w-1/2 mb-3" />
						<SkeletonLine className="h-4 w-3/4 mb-2" />
						<SkeletonLine className="h-4 w-2/3" />
					</div>
					<div className="p-4 border border-border rounded-lg">
						<SkeletonLine className="h-5 w-1/2 mb-3" />
						<SkeletonLine className="h-4 w-3/4 mb-2" />
						<SkeletonLine className="h-4 w-2/3" />
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div className="space-y-2">
						<SkeletonLine className="h-6 w-1/4" />
						<SkeletonLine className="h-4 w-1/2" />
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					<SkeletonLine className="h-10 w-full" />
					<SkeletonLine className="h-4 w-3/4" />
				</CardContent>
			</Card>
		</div>
	)
}
