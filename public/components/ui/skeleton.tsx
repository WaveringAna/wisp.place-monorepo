import { cn } from '@public/lib/utils'

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

function Skeleton({ className, ...props }: SkeletonProps) {
	return (
		<div
			className={cn(
				'animate-pulse rounded-md bg-muted',
				className
			)}
			{...props}
		/>
	)
}

interface SkeletonShimmerProps extends React.HTMLAttributes<HTMLDivElement> {}

function SkeletonShimmer({ className, ...props }: SkeletonShimmerProps) {
	return (
		<div
			className={cn(
				'relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_2s_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/10 before:to-transparent',
				className
			)}
			{...props}
		/>
	)
}

export { Skeleton, SkeletonShimmer }
