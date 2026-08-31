import { Button } from '@public/components/ui/button'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, RefreshCw, Upload, XCircle } from 'lucide-react'
import { type ChangeEvent, memo, useEffect, useRef, useState } from 'react'
import type { SiteWithDomains } from '../hooks/useSiteData'

type FileStatus = 'pending' | 'checking' | 'uploading' | 'uploaded' | 'reused' | 'failed'

interface FileProgress {
	name: string
	status: FileStatus
	error?: string
}

interface UploadTabProps {
	sites: SiteWithDomains[]
	sitesLoading: boolean
	onUploadComplete: () => Promise<void>
}

export const UploadTab = memo(function UploadTab({ sites, sitesLoading, onUploadComplete }: UploadTabProps) {
	// Upload state
	const [siteMode, setSiteMode] = useState<'existing' | 'new' | 'private'>('existing')
	const [selectedSiteRkey, setSelectedSiteRkey] = useState<string>('')
	const [newSiteName, setNewSiteName] = useState('')
	const [privateExpiryMode, setPrivateExpiryMode] = useState<'default' | 'never' | 'custom'>('default')
	const [privateExpiryMinutes, setPrivateExpiryMinutes] = useState('')
	const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null)
	const [isUploading, setIsUploading] = useState(false)
	const [uploadProgress, setUploadProgress] = useState('')
	const [skippedFiles, setSkippedFiles] = useState<Array<{ name: string; reason: string }>>([])
	const [failedFiles, setFailedFiles] = useState<Array<{ name: string; index: number; error: string; size: number }>>(
		[],
	)
	const [uploadedCount, setUploadedCount] = useState(0)
	const [fileProgressList, setFileProgressList] = useState<FileProgress[]>([])
	const [showFileProgress, setShowFileProgress] = useState(false)
	const [isDragging, setIsDragging] = useState(false)
	const publicSites = sites.filter((site) => !site.isPrivate)

	// Ref for the drop zone
	const dropZoneRef = useRef<HTMLButtonElement>(null)

	// Keep SSE connection alive across tab switches
	const eventSourceRef = useRef<EventSource | null>(null)
	const currentJobIdRef = useRef<string | null>(null)

	// Auto-switch to 'new' mode if no sites exist
	useEffect(() => {
		if (!sitesLoading && publicSites.length === 0 && siteMode === 'existing') {
			setSiteMode('new')
		}
	}, [publicSites.length, sitesLoading, siteMode])

	// Cleanup SSE connection on unmount
	useEffect(() => {
		return () => {
			// Don't close the connection on unmount (tab switch)
			// It will be reused when the component remounts
		}
	}, [])

	const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			setSelectedFiles(e.target.files)
		}
	}

	// Recursively read all files from a directory entry
	const readDirectory = async (entry: FileSystemDirectoryEntry): Promise<File[]> => {
		const files: File[] = []
		const reader = entry.createReader()

		const readEntries = (): Promise<FileSystemEntry[]> => {
			return new Promise((resolve, reject) => {
				reader.readEntries(resolve, reject)
			})
		}

		const getFile = (fileEntry: FileSystemFileEntry): Promise<File> => {
			return new Promise((resolve, reject) => {
				fileEntry.file(resolve, reject)
			})
		}

		// Read all entries (readEntries may need to be called multiple times)
		let entries: FileSystemEntry[] = []
		let batch: FileSystemEntry[]
		do {
			batch = await readEntries()
			entries = entries.concat(batch)
		} while (batch.length > 0)

		for (const childEntry of entries) {
			if (childEntry.isFile) {
				const file = await getFile(childEntry as FileSystemFileEntry)
				// Create a new File with the full path
				const fullPath = childEntry.fullPath.startsWith('/') ? childEntry.fullPath.slice(1) : childEntry.fullPath
				const fileWithPath = new File([file], fullPath, { type: file.type })
				files.push(fileWithPath)
			} else if (childEntry.isDirectory) {
				const subFiles = await readDirectory(childEntry as FileSystemDirectoryEntry)
				files.push(...subFiles)
			}
		}

		return files
	}

	// Handle dropped items (files or directories)
	const handleDrop = async (e: React.DragEvent<HTMLButtonElement>) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(false)

		if (isUploading) return

		const items = e.dataTransfer.items
		if (!items || items.length === 0) return

		const allFiles: File[] = []

		// Process all dropped items
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			const entry = item.webkitGetAsEntry()

			if (entry) {
				if (entry.isFile) {
					const file = await new Promise<File>((resolve, reject) => {
						;(entry as FileSystemFileEntry).file(resolve, reject)
					})
					allFiles.push(file)
				} else if (entry.isDirectory) {
					const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry)
					allFiles.push(...dirFiles)
				}
			}
		}

		if (allFiles.length > 0) {
			// Create a DataTransfer to build a FileList
			const dataTransfer = new DataTransfer()
			for (const file of allFiles) dataTransfer.items.add(file)
			setSelectedFiles(dataTransfer.files)
		}
	}

	const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
		e.preventDefault()
		e.stopPropagation()
		if (!isUploading) {
			setIsDragging(true)
		}
	}

	const handleDragEnter = (e: React.DragEvent<HTMLButtonElement>) => {
		e.preventDefault()
		e.stopPropagation()
		if (!isUploading) {
			setIsDragging(true)
		}
	}

	const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
		e.preventDefault()
		e.stopPropagation()
		// Only set isDragging to false if we're leaving the drop zone entirely
		if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
			setIsDragging(false)
		}
	}

	const handleDropZoneKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (isUploading) return
		if (e.key !== 'Enter' && e.key !== ' ') return

		e.preventDefault()
		document.getElementById('file-upload')?.click()
	}

	const setupSSE = (jobId: string) => {
		// Close existing connection if any
		if (eventSourceRef.current) {
			eventSourceRef.current.close()
		}

		currentJobIdRef.current = jobId
		const eventSource = new EventSource(`/wisp/upload-progress/${jobId}`)
		eventSourceRef.current = eventSource

		eventSource.addEventListener('progress', (event) => {
			const progressData = JSON.parse(event.data)
			const { progress } = progressData

			// Update file progress list if we have current file info
			if (progress.currentFile && progress.currentFileStatus) {
				setFileProgressList((prev) => {
					const existingIndex = prev.findIndex((f) => f.name === progress.currentFile)
					if (existingIndex !== -1) {
						// Update existing file status - create new array with single update
						const updated = [...prev]
						updated[existingIndex] = { ...updated[existingIndex], status: progress.currentFileStatus as FileStatus }
						return updated
					} else {
						// Add new file
						return [
							...prev,
							{
								name: progress.currentFile,
								status: progress.currentFileStatus as FileStatus,
							},
						]
					}
				})
			}

			// Update progress message based on phase
			let message = 'Processing...'
			if (progress.phase === 'validating') {
				message = 'Validating files...'
			} else if (progress.phase === 'compressing') {
				const current = progress.filesProcessed || 0
				const total = progress.totalFiles || 0
				message = `Compressing files (${current}/${total})...`
				if (progress.currentFile) {
					message += ` - ${progress.currentFile}`
				}
			} else if (progress.phase === 'uploading') {
				const uploaded = progress.filesUploaded || 0
				const reused = progress.filesReused || 0
				const total = progress.totalFiles || 0
				message = `Uploading to PDS (${uploaded + reused}/${total})...`
			} else if (progress.phase === 'creating_manifest') {
				message = 'Creating manifest...'
			} else if (progress.phase === 'finalizing') {
				message = 'Finalizing upload...'
			}

			setUploadProgress(message)
		})

		eventSource.addEventListener('done', (event) => {
			const result = JSON.parse(event.data)
			eventSource.close()
			eventSourceRef.current = null
			currentJobIdRef.current = null

			const hasIssues =
				(result.skippedFiles && result.skippedFiles.length > 0) || (result.failedFiles && result.failedFiles.length > 0)

			// Update file progress list with failed files
			if (result.failedFiles && result.failedFiles.length > 0) {
				setFileProgressList((prev) => {
					const updated = [...prev]
					result.failedFiles.forEach((failedFile: any) => {
						const existingIndex = updated.findIndex((f) => f.name === failedFile.name)
						if (existingIndex !== -1) {
							updated[existingIndex] = {
								...updated[existingIndex],
								status: 'failed',
								error: failedFile.error,
							}
						} else {
							updated.push({
								name: failedFile.name,
								status: 'failed',
								error: failedFile.error,
							})
						}
					})
					return updated
				})
			}

			setUploadProgress(hasIssues ? 'Upload completed with issues' : 'Upload complete!')
			setSkippedFiles(result.skippedFiles || [])
			setFailedFiles(result.failedFiles || [])
			setUploadedCount(result.uploadedCount || result.fileCount || 0)

			// Debug: log failed files
			console.log('Failed files:', result.failedFiles)

			// Check for 419/413 errors and show alert
			const hasSizeError = result.failedFiles?.some((file: any) => {
				const error = file.error?.toLowerCase() || ''
				console.log('Checking error:', error, 'contains PDS?', error.includes('pds'))
				return (
					error.includes('pds is not allowing') ||
					error.includes('your pds is not allowing') ||
					error.includes('request entity too large')
				)
			})

			console.log('Has size error:', hasSizeError)

			if (hasSizeError) {
				window.alert(
					'Some files were too large for your PDS. Your PDS is not allowing uploads large enough to store your site. Please contact your PDS host. This could also possibly be a result of it being behind Cloudflare free tier.',
				)
			}

			setSelectedSiteRkey('')
			setNewSiteName('')
			setSelectedFiles(null)

			// Refresh sites list
			onUploadComplete()

			// Reset form (wait longer if there are issues to show)
			const resetDelay = hasIssues ? 6000 : 1500
			setTimeout(() => {
				setUploadProgress('')
				setSkippedFiles([])
				setFailedFiles([])
				setUploadedCount(0)
				setFileProgressList([])
				setIsUploading(false)
			}, resetDelay)
		})

		eventSource.addEventListener('error', (event) => {
			const errorData = JSON.parse((event as any).data || '{}')
			eventSource.close()
			eventSourceRef.current = null
			currentJobIdRef.current = null

			console.error('Upload error:', errorData)
			alert(`Upload failed: ${errorData.error || 'Unknown error'}`)
			setIsUploading(false)
			setUploadProgress('')
		})

		eventSource.onerror = () => {
			eventSource.close()
			eventSourceRef.current = null
			currentJobIdRef.current = null

			console.error('SSE connection error')
			alert('Lost connection to upload progress. The upload may still be processing.')
			setIsUploading(false)
			setUploadProgress('')
		}
	}

	const handleUpload = async () => {
		const siteName = siteMode === 'existing' ? selectedSiteRkey : newSiteName.trim()

		if (!siteName) {
			alert(siteMode === 'existing' ? 'Please select a site' : 'Please enter a site name')
			return
		}
		if (siteMode === 'private' && (!selectedFiles || selectedFiles.length === 0)) {
			alert('Please choose at least one file for the private site')
			return
		}

		setIsUploading(true)
		setUploadProgress('Preparing files...')

		try {
			const formData = new FormData()
			formData.append(siteMode === 'private' ? 'name' : 'siteName', siteName)
			if (siteMode === 'private') {
				if (privateExpiryMode === 'never') {
					formData.append('expiryMinutes', '0')
				} else if (privateExpiryMode === 'custom') {
					const expiryMinutes = Number(privateExpiryMinutes)
					if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1) {
						throw new Error('Expiry must be a positive whole number of minutes')
					}
					formData.append('expiryMinutes', String(expiryMinutes))
				}
			}

			if (selectedFiles) {
				for (let i = 0; i < selectedFiles.length; i++) {
					const file = selectedFiles[i]
					const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
					formData.append('files', file, path)
				}
			}

			if (siteMode === 'private') {
				setUploadProgress('Uploading privately...')
				const response = await fetch('/api/user/private-sites', {
					method: 'POST',
					body: formData,
				})
				const data = await response.json()
				if (!response.ok || !data.success) {
					throw new Error(data.error || 'Private upload failed')
				}

				setUploadProgress('Private site created!')
				setNewSiteName('')
				setSelectedFiles(null)
				setPrivateExpiryMode('default')
				setPrivateExpiryMinutes('')
				await onUploadComplete()
				setTimeout(() => {
					setUploadProgress('')
					setIsUploading(false)
				}, 1500)
				return
			}

			// If no files, handle synchronously (old behavior)
			if (!selectedFiles || selectedFiles.length === 0) {
				setUploadProgress('Creating empty site...')
				const response = await fetch('/wisp/upload-files', {
					method: 'POST',
					body: formData,
				})

				const data = await response.json()
				if (data.success) {
					setUploadProgress('Site created!')
					setSelectedSiteRkey('')
					setNewSiteName('')
					setSelectedFiles(null)

					await onUploadComplete()

					setTimeout(() => {
						setUploadProgress('')
						setIsUploading(false)
					}, 1500)
				} else {
					throw new Error(data.error || 'Upload failed')
				}
				return
			}

			// For file uploads, use SSE for progress
			setUploadProgress('Starting upload...')
			const response = await fetch('/wisp/upload-files', {
				method: 'POST',
				body: formData,
			})

			const data = await response.json()
			if (!data.success || !data.jobId) {
				throw new Error(data.error || 'Failed to start upload')
			}

			const jobId = data.jobId
			setUploadProgress('Connecting to progress stream...')

			// Setup SSE connection (persists across tab switches via ref)
			setupSSE(jobId)
		} catch (err) {
			console.error('Upload error:', err)
			alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
			setIsUploading(false)
			setUploadProgress('')
		}
	}

	return (
		<div className="h-full flex flex-col border border-border/30 bg-card/50 font-mono">
			{/* Header */}
			<div className="p-4 pb-3 border-b border-border/30 flex-shrink-0">
				<p className="text-sm font-semibold">Upload Site</p>
				<p className="text-xs text-muted-foreground mt-0.5">
					{siteMode === 'private' ? '100MB total · stored privately by wisp' : '200MB per file · 300MB total'}
				</p>
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
				{/* Mode toggle */}
				<div className="flex border border-border/30 overflow-hidden">
					<button
						className={`flex-1 py-2 text-sm transition-colors ${
							siteMode === 'existing' ? 'bg-accent/20 text-foreground' : 'text-muted-foreground hover:bg-muted/30'
						}`}
						type="button"
						onClick={() => setSiteMode('existing')}
						disabled={isUploading}
					>
						Update existing
					</button>
					<button
						className={`flex-1 py-2 text-sm border-l border-border/30 transition-colors ${
							siteMode === 'new' ? 'bg-accent/20 text-foreground' : 'text-muted-foreground hover:bg-muted/30'
						}`}
						type="button"
						onClick={() => setSiteMode('new')}
						disabled={isUploading}
					>
						Create public
					</button>
					<button
						aria-label="Choose private upload"
						className={`flex-1 py-2 text-sm border-l border-border/30 transition-colors ${
							siteMode === 'private' ? 'bg-accent/20 text-foreground' : 'text-muted-foreground hover:bg-muted/30'
						}`}
						type="button"
						onClick={() => setSiteMode('private')}
						disabled={isUploading}
					>
						Upload privately
					</button>
				</div>

				{/* Site selector / name */}
				{siteMode === 'existing' ? (
					sitesLoading ? (
						<div className="flex items-center gap-2 p-3 border border-border/30 text-xs text-muted-foreground">
							<Loader2 className="w-3 h-3 animate-spin" />
							Loading sites...
						</div>
					) : publicSites.length === 0 ? (
						<p className="text-xs text-muted-foreground p-3 border border-dashed border-border/50">
							No public sites yet — switch to "Create public" above.
						</p>
					) : (
						<div className="space-y-1">
							<Label htmlFor="site-select" className="text-xs">
								Site
							</Label>
							<select
								id="site-select"
								className="flex h-9 w-full border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
								value={selectedSiteRkey}
								onChange={(e) => setSelectedSiteRkey(e.target.value)}
								disabled={isUploading}
							>
								<option value="">Select a site...</option>
								{publicSites.map((site) => (
									<option key={site.rkey} value={site.rkey}>
										{site.display_name || site.rkey}
									</option>
								))}
							</select>
						</div>
					)
				) : (
					<div className="space-y-1">
						<Label htmlFor="new-site-name" className="text-xs">
							{siteMode === 'private' ? 'Private site name' : 'Site name'}
						</Label>
						<Input
							id="new-site-name"
							placeholder="my-awesome-site"
							value={newSiteName}
							onChange={(e: ChangeEvent<HTMLInputElement>) => setNewSiteName(e.target.value)}
							disabled={isUploading}
							className="h-9"
						/>
					</div>
				)}

				{siteMode === 'private' && (
					<div className="space-y-1">
						<Label htmlFor="private-expiry" className="text-xs">
							Expiry
						</Label>
						<select
							id="private-expiry"
							className="flex h-9 w-full border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							value={privateExpiryMode}
							onChange={(event) => setPrivateExpiryMode(event.target.value as 'default' | 'never' | 'custom')}
							disabled={isUploading}
						>
							<option value="default">Default (7 days)</option>
							<option value="never">Never expires</option>
							<option value="custom">Custom minutes</option>
						</select>
						{privateExpiryMode === 'custom' && (
							<Input
								aria-label="Private site expiry in minutes"
								type="number"
								min={1}
								max={525600}
								step={1}
								placeholder="minutes"
								value={privateExpiryMinutes}
								onChange={(event: ChangeEvent<HTMLInputElement>) => setPrivateExpiryMinutes(event.target.value)}
								disabled={isUploading}
								className="h-9"
							/>
						)}
						<p className="text-[11px] text-muted-foreground">
							Private files stay off your PDS and never enter the firehose.
						</p>
					</div>
				)}

				{/* Drop zone */}
				<button
					type="button"
					className={`w-full text-left border-2 border-dashed p-4 flex items-center gap-3 transition-colors ${
						isDragging
							? 'border-accent bg-accent/10 cursor-copy'
							: isUploading
								? 'opacity-50 cursor-not-allowed border-border/30'
								: 'border-border/30 hover:border-accent cursor-pointer'
					}`}
					ref={dropZoneRef}
					disabled={isUploading}
					onDrop={handleDrop}
					onDragOver={handleDragOver}
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onKeyDown={handleDropZoneKeyDown}
					onClick={() => !isUploading && document.getElementById('file-upload')?.click()}
				>
					<Upload
						className={`w-4 h-4 flex-shrink-0 transition-colors ${isDragging ? 'text-accent' : 'text-muted-foreground'}`}
					/>
					<span className="text-sm text-muted-foreground flex-1">
						{isDragging ? (
							'Drop here...'
						) : selectedFiles && selectedFiles.length > 0 ? (
							<span className="text-accent font-medium">{selectedFiles.length} files selected</span>
						) : (
							'Drop a folder or click to choose'
						)}
					</span>
					<input
						type="file"
						id="file-upload"
						multiple
						onChange={handleFileSelect}
						className="hidden"
						{...({ webkitdirectory: '', directory: '' } as any)}
						disabled={isUploading}
					/>
				</button>

				{/* Progress */}
				{uploadProgress && (
					<div className="space-y-2">
						<div className="flex items-center gap-2 p-3 bg-muted/50 border border-border/30 text-sm">
							<Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
							<span>{uploadProgress}</span>
						</div>

						{fileProgressList.length > 0 && (
							<div className="border border-border/30 overflow-hidden">
								<button
									type="button"
									onClick={() => setShowFileProgress(!showFileProgress)}
									className="w-full px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors flex items-center justify-between text-xs"
								>
									<span>
										Files ({fileProgressList.filter((f) => f.status === 'uploaded' || f.status === 'reused').length}/
										{fileProgressList.length})
									</span>
									{showFileProgress ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
								</button>
								{showFileProgress && (
									<div className="max-h-48 overflow-y-auto p-2 space-y-0.5 bg-background">
										{fileProgressList.map((file) => (
											<div key={file.name} className="flex items-start gap-2 text-xs p-1.5 hover:bg-muted/30">
												{file.status === 'checking' && (
													<Loader2 className="w-3 h-3 mt-0.5 animate-spin text-blue-500 shrink-0" />
												)}
												{file.status === 'uploading' && (
													<Loader2 className="w-3 h-3 mt-0.5 animate-spin text-purple-500 shrink-0" />
												)}
												{file.status === 'uploaded' && (
													<CheckCircle2 className="w-3 h-3 mt-0.5 text-green-500 shrink-0" />
												)}
												{file.status === 'reused' && <RefreshCw className="w-3 h-3 mt-0.5 text-cyan-500 shrink-0" />}
												{file.status === 'failed' && <XCircle className="w-3 h-3 mt-0.5 text-red-500 shrink-0" />}
												<div className="flex-1 min-w-0">
													<div className="font-mono truncate">{file.name}</div>
													{file.error && <div className="text-red-500">{file.error}</div>}
													{file.status === 'checking' && <div className="text-muted-foreground">Checking...</div>}
													{file.status === 'uploading' && <div className="text-muted-foreground">Uploading...</div>}
													{file.status === 'reused' && <div className="text-muted-foreground">Unchanged</div>}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{failedFiles.length > 0 && (
							<div className="p-3 bg-red-500/10 border border-red-500/20 text-xs space-y-1">
								<div className="flex items-center gap-2 text-red-400 font-medium">
									<AlertCircle className="w-3 h-3 shrink-0" />
									{failedFiles.length} file{failedFiles.length > 1 ? 's' : ''} failed
									{uploadedCount > 0 && <span className="font-normal text-muted-foreground">({uploadedCount} ok)</span>}
								</div>
								<div className="ml-5 space-y-1 max-h-32 overflow-y-auto">
									{failedFiles.slice(0, 10).map((file) => (
										<div key={file.name}>
											<span className="font-mono">{file.name}</span>
											<span className="text-muted-foreground">
												{' '}
												— {file.error}
												{file.size > 0 && ` (${(file.size / 1024).toFixed(1)}KB)`}
											</span>
										</div>
									))}
									{failedFiles.length > 10 && (
										<div className="text-muted-foreground">…and {failedFiles.length - 10} more</div>
									)}
								</div>
							</div>
						)}

						{skippedFiles.length > 0 && (
							<div className="p-3 bg-yellow-500/10 border border-yellow-500/20 text-xs space-y-1">
								<div className="flex items-center gap-2 text-yellow-500 font-medium">
									<AlertCircle className="w-3 h-3 shrink-0" />
									{skippedFiles.length} file{skippedFiles.length > 1 ? 's' : ''} skipped
								</div>
								<div className="ml-5 space-y-0.5 max-h-24 overflow-y-auto">
									{skippedFiles.slice(0, 5).map((file) => (
										<div key={file.name}>
											<span className="font-mono">{file.name}</span>
											<span className="text-muted-foreground"> — {file.reason}</span>
										</div>
									))}
									{skippedFiles.length > 5 && (
										<div className="text-muted-foreground">…and {skippedFiles.length - 5} more</div>
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{/* Upload button */}
				<Button
					onClick={handleUpload}
					className="w-full"
					disabled={
						(siteMode === 'existing' ? !selectedSiteRkey : !newSiteName) ||
						isUploading ||
						((siteMode === 'existing' || siteMode === 'private') && (!selectedFiles || selectedFiles.length === 0)) ||
						(siteMode === 'private' && privateExpiryMode === 'custom' && !privateExpiryMinutes)
					}
				>
					{isUploading ? (
						<>
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
							Uploading...
						</>
					) : siteMode === 'existing' ? (
						'Update Site'
					) : siteMode === 'private' ? (
						'Upload privately'
					) : selectedFiles && selectedFiles.length > 0 ? (
						'Upload & Deploy'
					) : (
						'Create Empty Site'
					)}
				</Button>
			</div>
		</div>
	)
})
