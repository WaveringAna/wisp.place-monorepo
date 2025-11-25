import { createLogger } from '@wisp/observability';

const logger = createLogger('main-app');

export type UploadJobStatus = 'pending' | 'processing' | 'uploading' | 'completed' | 'failed';

export interface UploadProgress {
	filesProcessed: number;
	totalFiles: number;
	filesUploaded: number;
	filesReused: number;
	currentFile?: string;
	currentFileStatus?: 'checking' | 'uploading' | 'uploaded' | 'reused' | 'failed';
	phase: 'validating' | 'compressing' | 'uploading' | 'creating_manifest' | 'finalizing' | 'done';
}

export interface UploadJob {
	id: string;
	did: string;
	siteName: string;
	status: UploadJobStatus;
	progress: UploadProgress;
	result?: {
		success: boolean;
		uri?: string;
		cid?: string;
		fileCount?: number;
		siteName?: string;
		skippedFiles?: Array<{ name: string; reason: string }>;
		failedFiles?: Array<{ name: string; index: number; error: string; size: number }>;
		uploadedCount?: number;
		hasFailures?: boolean;
	};
	error?: string;
	createdAt: number;
	updatedAt: number;
}

// In-memory job storage
const jobs = new Map<string, UploadJob>();

// SSE connections for each job
const jobListeners = new Map<string, Set<(event: string, data: any) => void>>();

// Cleanup old jobs after 1 hour
const JOB_TTL = 60 * 60 * 1000;

export function createUploadJob(did: string, siteName: string, totalFiles: number): string {
	const id = crypto.randomUUID();
	const now = Date.now();

	const job: UploadJob = {
		id,
		did,
		siteName,
		status: 'pending',
		progress: {
			filesProcessed: 0,
			totalFiles,
			filesUploaded: 0,
			filesReused: 0,
			phase: 'validating'
		},
		createdAt: now,
		updatedAt: now
	};

	jobs.set(id, job);
	logger.info(`Upload job created: ${id} for ${did}/${siteName} (${totalFiles} files)`);

	// Schedule cleanup
	setTimeout(() => {
		jobs.delete(id);
		jobListeners.delete(id);
		logger.info(`Upload job cleaned up: ${id}`);
	}, JOB_TTL);

	return id;
}

export function getUploadJob(id: string): UploadJob | undefined {
	return jobs.get(id);
}

export function updateUploadJob(
	id: string,
	updates: Partial<Omit<UploadJob, 'id' | 'did' | 'siteName' | 'createdAt'>>
): void {
	const job = jobs.get(id);
	if (!job) {
		logger.warn(`Attempted to update non-existent job: ${id}`);
		return;
	}

	Object.assign(job, updates, { updatedAt: Date.now() });
	jobs.set(id, job);

	// Notify all listeners
	const listeners = jobListeners.get(id);
	if (listeners && listeners.size > 0) {
		const eventData = {
			status: job.status,
			progress: job.progress,
			result: job.result,
			error: job.error
		};

		const failedListeners: Array<(event: string, data: any) => void> = [];
		listeners.forEach(listener => {
			try {
				listener('progress', eventData);
			} catch (err) {
				// Client disconnected, remove this listener
				failedListeners.push(listener);
			}
		});

		// Remove failed listeners
		failedListeners.forEach(listener => listeners.delete(listener));
	}
}

export function completeUploadJob(id: string, result: UploadJob['result']): void {
	updateUploadJob(id, {
		status: 'completed',
		progress: {
			...getUploadJob(id)!.progress,
			phase: 'done'
		},
		result
	});

	// Send final event and close connections
	setTimeout(() => {
		const listeners = jobListeners.get(id);
		if (listeners) {
			listeners.forEach(listener => {
				try {
					listener('done', result);
				} catch (err) {
					// Client already disconnected, ignore
				}
			});
			jobListeners.delete(id);
		}
	}, 100);
}

export function failUploadJob(id: string, error: string): void {
	updateUploadJob(id, {
		status: 'failed',
		error
	});

	// Send error event and close connections
	setTimeout(() => {
		const listeners = jobListeners.get(id);
		if (listeners) {
			listeners.forEach(listener => {
				try {
					listener('error', { error });
				} catch (err) {
					// Client already disconnected, ignore
				}
			});
			jobListeners.delete(id);
		}
	}, 100);
}

export function addJobListener(jobId: string, listener: (event: string, data: any) => void): () => void {
	if (!jobListeners.has(jobId)) {
		jobListeners.set(jobId, new Set());
	}
	jobListeners.get(jobId)!.add(listener);

	// Return cleanup function
	return () => {
		const listeners = jobListeners.get(jobId);
		if (listeners) {
			listeners.delete(listener);
			if (listeners.size === 0) {
				jobListeners.delete(jobId);
			}
		}
	};
}

export function updateJobProgress(
	jobId: string,
	progressUpdate: Partial<UploadProgress>
): void {
	const job = getUploadJob(jobId);
	if (!job) return;

	updateUploadJob(jobId, {
		progress: {
			...job.progress,
			...progressUpdate
		}
	});
}
