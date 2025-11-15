import { useState, useEffect, useRef } from 'react'
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
} from '@public/components/ui/card'
import { Button } from '@public/components/ui/button'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@public/components/ui/radio-group'
import { Badge } from '@public/components/ui/badge'
import {
    Globe,
    Upload,
    AlertCircle,
    Loader2,
    ChevronDown,
    ChevronUp,
    CheckCircle2,
    XCircle,
    RefreshCw
} from 'lucide-react'
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

export function UploadTab({
    sites,
    sitesLoading,
    onUploadComplete
}: UploadTabProps) {
    // Upload state
    const [siteMode, setSiteMode] = useState<'existing' | 'new'>('existing')
    const [selectedSiteRkey, setSelectedSiteRkey] = useState<string>('')
    const [newSiteName, setNewSiteName] = useState('')
    const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null)
    const [isUploading, setIsUploading] = useState(false)
    const [uploadProgress, setUploadProgress] = useState('')
    const [skippedFiles, setSkippedFiles] = useState<Array<{ name: string; reason: string }>>([])
    const [failedFiles, setFailedFiles] = useState<Array<{ name: string; index: number; error: string; size: number }>>([])
    const [uploadedCount, setUploadedCount] = useState(0)
    const [fileProgressList, setFileProgressList] = useState<FileProgress[]>([])
    const [showFileProgress, setShowFileProgress] = useState(false)

    // Keep SSE connection alive across tab switches
    const eventSourceRef = useRef<EventSource | null>(null)
    const currentJobIdRef = useRef<string | null>(null)

    // Auto-switch to 'new' mode if no sites exist
    useEffect(() => {
        if (!sitesLoading && sites.length === 0 && siteMode === 'existing') {
            setSiteMode('new')
        }
    }, [sites, sitesLoading, siteMode])

    // Cleanup SSE connection on unmount
    useEffect(() => {
        return () => {
            // Don't close the connection on unmount (tab switch)
            // It will be reused when the component remounts
        }
    }, [])

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setSelectedFiles(e.target.files)
        }
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
            const { progress, status } = progressData

            // Update file progress list if we have current file info
            if (progress.currentFile && progress.currentFileStatus) {
                setFileProgressList(prev => {
                    const existingIndex = prev.findIndex(f => f.name === progress.currentFile)
                    if (existingIndex !== -1) {
                        // Update existing file status - create new array with single update
                        const updated = [...prev]
                        updated[existingIndex] = { ...updated[existingIndex], status: progress.currentFileStatus as FileStatus }
                        return updated
                    } else {
                        // Add new file
                        return [...prev, {
                            name: progress.currentFile,
                            status: progress.currentFileStatus as FileStatus
                        }]
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

            const hasIssues = (result.skippedFiles && result.skippedFiles.length > 0) ||
                              (result.failedFiles && result.failedFiles.length > 0)

            // Update file progress list with failed files
            if (result.failedFiles && result.failedFiles.length > 0) {
                setFileProgressList(prev => {
                    const updated = [...prev]
                    result.failedFiles.forEach((failedFile: any) => {
                        const existingIndex = updated.findIndex(f => f.name === failedFile.name)
                        if (existingIndex !== -1) {
                            updated[existingIndex] = {
                                ...updated[existingIndex],
                                status: 'failed',
                                error: failedFile.error
                            }
                        } else {
                            updated.push({
                                name: failedFile.name,
                                status: 'failed',
                                error: failedFile.error
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
            alert(
                `Upload failed: ${errorData.error || 'Unknown error'}`
            )
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
        const siteName = siteMode === 'existing' ? selectedSiteRkey : newSiteName

        if (!siteName) {
            alert(siteMode === 'existing' ? 'Please select a site' : 'Please enter a site name')
            return
        }

        setIsUploading(true)
        setUploadProgress('Preparing files...')

        try {
            const formData = new FormData()
            formData.append('siteName', siteName)

            if (selectedFiles) {
                for (let i = 0; i < selectedFiles.length; i++) {
                    formData.append('files', selectedFiles[i])
                }
            }

            // If no files, handle synchronously (old behavior)
            if (!selectedFiles || selectedFiles.length === 0) {
                setUploadProgress('Creating empty site...')
                const response = await fetch('/wisp/upload-files', {
                    method: 'POST',
                    body: formData
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
                body: formData
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
            alert(
                `Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`
            )
            setIsUploading(false)
            setUploadProgress('')
        }
    }

    return (
        <div className="space-y-4 min-h-[400px]">
            <Card>
                <CardHeader>
                    <CardTitle>Upload Site</CardTitle>
                    <CardDescription>
                        Deploy a new site from a folder or Git repository
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="space-y-4">
                        <div className="p-4 bg-muted/50 rounded-lg">
                            <RadioGroup
                                value={siteMode}
                                onValueChange={(value) => setSiteMode(value as 'existing' | 'new')}
                                disabled={isUploading}
                            >
                                <div className="flex items-center space-x-2">
                                    <RadioGroupItem value="existing" id="existing" />
                                    <Label htmlFor="existing" className="cursor-pointer">
                                        Update existing site
                                    </Label>
                                </div>
                                <div className="flex items-center space-x-2">
                                    <RadioGroupItem value="new" id="new" />
                                    <Label htmlFor="new" className="cursor-pointer">
                                        Create new site
                                    </Label>
                                </div>
                            </RadioGroup>
                        </div>

                        {siteMode === 'existing' ? (
                            <div className="space-y-2">
                                <Label htmlFor="site-select">Select Site</Label>
                                {sitesLoading ? (
                                    <div className="flex items-center justify-center py-4">
                                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                    </div>
                                ) : sites.length === 0 ? (
                                    <div className="p-4 border border-dashed rounded-lg text-center text-sm text-muted-foreground">
                                        No sites available. Create a new site instead.
                                    </div>
                                ) : (
                                    <select
                                        id="site-select"
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                        value={selectedSiteRkey}
                                        onChange={(e) => setSelectedSiteRkey(e.target.value)}
                                        disabled={isUploading}
                                    >
                                        <option value="">Select a site...</option>
                                        {sites.map((site) => (
                                            <option key={site.rkey} value={site.rkey}>
                                                {site.display_name || site.rkey}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <Label htmlFor="new-site-name">New Site Name</Label>
                                <Input
                                    id="new-site-name"
                                    placeholder="my-awesome-site"
                                    value={newSiteName}
                                    onChange={(e) => setNewSiteName(e.target.value)}
                                    disabled={isUploading}
                                />
                            </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                            File limits: 100MB per file, 300MB total
                        </p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                        <Card className="border-2 border-dashed hover:border-accent transition-colors cursor-pointer">
                            <CardContent className="flex flex-col items-center justify-center p-8 text-center">
                                <Upload className="w-12 h-12 text-muted-foreground mb-4" />
                                <h3 className="font-semibold mb-2">
                                    Upload Folder
                                </h3>
                                <p className="text-sm text-muted-foreground mb-4">
                                    Drag and drop or click to upload your
                                    static site files
                                </p>
                                <input
                                    type="file"
                                    id="file-upload"
                                    multiple
                                    onChange={handleFileSelect}
                                    className="hidden"
                                    {...(({ webkitdirectory: '', directory: '' } as any))}
                                    disabled={isUploading}
                                />
                                <label htmlFor="file-upload">
                                    <Button
                                        variant="outline"
                                        type="button"
                                        onClick={() =>
                                            document
                                                .getElementById('file-upload')
                                                ?.click()
                                        }
                                        disabled={isUploading}
                                    >
                                        Choose Folder
                                    </Button>
                                </label>
                                {selectedFiles && selectedFiles.length > 0 && (
                                    <p className="text-sm text-muted-foreground mt-3">
                                        {selectedFiles.length} files selected
                                    </p>
                                )}
                            </CardContent>
                        </Card>

                        <Card className="border-2 border-dashed opacity-50">
                            <CardContent className="flex flex-col items-center justify-center p-8 text-center">
                                <Globe className="w-12 h-12 text-muted-foreground mb-4" />
                                <h3 className="font-semibold mb-2">
                                    Connect Git Repository
                                </h3>
                                <p className="text-sm text-muted-foreground mb-4">
                                    Link your GitHub, GitLab, or any Git
                                    repository
                                </p>
                                <Badge variant="secondary">Coming soon!</Badge>
                            </CardContent>
                        </Card>
                    </div>

                    {uploadProgress && (
                        <div className="space-y-3">
                            <div className="p-4 bg-muted rounded-lg">
                                <div className="flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span className="text-sm">{uploadProgress}</span>
                                </div>
                            </div>

                            {fileProgressList.length > 0 && (
                                <div className="border rounded-lg overflow-hidden">
                                    <button
                                        onClick={() => setShowFileProgress(!showFileProgress)}
                                        className="w-full p-3 bg-muted/50 hover:bg-muted transition-colors flex items-center justify-between text-sm font-medium"
                                    >
                                        <span>
                                            Processing files ({fileProgressList.filter(f => f.status === 'uploaded' || f.status === 'reused').length}/{fileProgressList.length})
                                        </span>
                                        {showFileProgress ? (
                                            <ChevronUp className="w-4 h-4" />
                                        ) : (
                                            <ChevronDown className="w-4 h-4" />
                                        )}
                                    </button>
                                    {showFileProgress && (
                                        <div className="max-h-64 overflow-y-auto p-3 space-y-1 bg-background">
                                            {fileProgressList.map((file, idx) => (
                                                <div
                                                    key={idx}
                                                    className="flex items-start gap-2 text-xs p-2 rounded hover:bg-muted/50 transition-colors"
                                                >
                                                    {file.status === 'checking' && (
                                                        <Loader2 className="w-3 h-3 mt-0.5 animate-spin text-blue-500 shrink-0" />
                                                    )}
                                                    {file.status === 'uploading' && (
                                                        <Loader2 className="w-3 h-3 mt-0.5 animate-spin text-purple-500 shrink-0" />
                                                    )}
                                                    {file.status === 'uploaded' && (
                                                        <CheckCircle2 className="w-3 h-3 mt-0.5 text-green-500 shrink-0" />
                                                    )}
                                                    {file.status === 'reused' && (
                                                        <RefreshCw className="w-3 h-3 mt-0.5 text-cyan-500 shrink-0" />
                                                    )}
                                                    {file.status === 'failed' && (
                                                        <XCircle className="w-3 h-3 mt-0.5 text-red-500 shrink-0" />
                                                    )}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-mono truncate">{file.name}</div>
                                                        {file.error && (
                                                            <div className="text-red-500 mt-0.5">
                                                                {file.error}
                                                            </div>
                                                        )}
                                                        {file.status === 'checking' && (
                                                            <div className="text-muted-foreground">Checking for changes...</div>
                                                        )}
                                                        {file.status === 'uploading' && (
                                                            <div className="text-muted-foreground">Uploading to PDS...</div>
                                                        )}
                                                        {file.status === 'reused' && (
                                                            <div className="text-muted-foreground">Reused (unchanged)</div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {failedFiles.length > 0 && (
                                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                                    <div className="flex items-start gap-2 text-red-600 dark:text-red-400 mb-2">
                                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                        <div className="flex-1">
                                            <span className="font-medium">
                                                {failedFiles.length} file{failedFiles.length > 1 ? 's' : ''} failed to upload
                                            </span>
                                            {uploadedCount > 0 && (
                                                <span className="text-sm ml-2">
                                                    ({uploadedCount} uploaded successfully)
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="ml-6 space-y-1 max-h-40 overflow-y-auto">
                                        {failedFiles.slice(0, 10).map((file, idx) => (
                                            <div key={idx} className="text-xs">
                                                <div className="font-mono font-semibold">{file.name}</div>
                                                <div className="text-muted-foreground ml-2">
                                                    Error: {file.error}
                                                    {file.size > 0 && ` (${(file.size / 1024).toFixed(1)} KB)`}
                                                </div>
                                            </div>
                                        ))}
                                        {failedFiles.length > 10 && (
                                            <div className="text-xs text-muted-foreground">
                                                ...and {failedFiles.length - 10} more
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {skippedFiles.length > 0 && (
                                <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                    <div className="flex items-start gap-2 text-yellow-600 dark:text-yellow-400 mb-2">
                                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                        <div className="flex-1">
                                            <span className="font-medium">
                                                {skippedFiles.length} file{skippedFiles.length > 1 ? 's' : ''} skipped
                                            </span>
                                        </div>
                                    </div>
                                    <div className="ml-6 space-y-1 max-h-32 overflow-y-auto">
                                        {skippedFiles.slice(0, 5).map((file, idx) => (
                                            <div key={idx} className="text-xs">
                                                <span className="font-mono">{file.name}</span>
                                                <span className="text-muted-foreground"> - {file.reason}</span>
                                            </div>
                                        ))}
                                        {skippedFiles.length > 5 && (
                                            <div className="text-xs text-muted-foreground">
                                                ...and {skippedFiles.length - 5} more
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <Button
                        onClick={handleUpload}
                        className="w-full"
                        disabled={
                            (siteMode === 'existing' ? !selectedSiteRkey : !newSiteName) ||
                            isUploading ||
                            (siteMode === 'existing' && (!selectedFiles || selectedFiles.length === 0))
                        }
                    >
                        {isUploading ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Uploading...
                            </>
                        ) : (
                            <>
                                {siteMode === 'existing' ? (
                                    'Update Site'
                                ) : (
                                    selectedFiles && selectedFiles.length > 0
                                        ? 'Upload & Deploy'
                                        : 'Create Empty Site'
                                )}
                            </>
                        )}
                    </Button>
                </CardContent>
            </Card>
        </div>
    )
}
