import { useQueryClient } from '@tanstack/react-query'
import { type DragEvent, type FormEvent, useId, useRef, useState } from 'react'
import type { UserInfo } from '../api'
import { formatBytes, plural } from '../format'
import { defaultSiteAddress, type PublicSite, siteAddress } from '../model'
import { keys, useSites } from '../queries'
import { notify } from '../store'
import { Button, cx, Input, Section, Segmented } from '../ui'
import { rootedUploadPaths, uploadRoot } from '../upload-paths'
import { hitPdsSizeLimit, RECENT_FILES, type UploadResult, type UploadState, useUpload } from '../upload-progress'

type Mode = 'update' | 'create' | 'private'
type Expiry = 'default' | 'never' | 'custom'

const MODES = [
	{ value: 'update', label: 'update a site' },
	{ value: 'create', label: 'new site' },
	{ value: 'private', label: 'private' },
] as const

const EXPIRIES = [
	{ value: 'default', label: '7 days' },
	{ value: 'never', label: 'never' },
	{ value: 'custom', label: 'custom' },
] as const

const readEntries = (reader: FileSystemDirectoryReader) =>
	new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))

/** readEntries hands back directories in batches; an empty batch means done. */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	const batch = await readEntries(reader)
	return batch.length ? [...batch, ...(await readAllEntries(reader))] : []
}

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile
const isDirectoryEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory

/** Files under a dropped entry, named by their path so the folder layout survives the upload. */
async function entryFiles(entry: FileSystemEntry): Promise<File[]> {
	if (isFileEntry(entry)) {
		const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject))
		return [new File([file], entry.fullPath.replace(/^\//, ''), { type: file.type, lastModified: file.lastModified })]
	}
	if (isDirectoryEntry(entry)) {
		const children = await readAllEntries(entry.createReader())
		return (await Promise.all(children.map(entryFiles))).flat()
	}
	return []
}

const droppedFiles = async (items: DataTransferItemList) =>
	(
		await Promise.all(
			Array.from(items, (item) => item.webkitGetAsEntry())
				.filter((entry) => entry !== null)
				.map(entryFiles),
		)
	).flat()

const totalBytes = (files: readonly File[]) => files.reduce((sum, file) => sum + file.size, 0)

interface UploadForm {
	mode: Mode
	name: string
	expiry: Expiry
	minutes: string
	files: readonly File[]
}

/** The multipart body both upload endpoints expect; private sites name their fields differently. */
function uploadBody({ mode, name, expiry, minutes, files }: UploadForm): FormData {
	const body = new FormData()
	body.append(mode === 'private' ? 'name' : 'siteName', name)
	if (mode === 'private' && expiry !== 'default') body.append('expiryMinutes', expiry === 'never' ? '0' : minutes)
	const paths = rootedUploadPaths(files)
	files.forEach((file, index) => {
		body.append('files', file, paths[index])
	})
	return body
}

const submitLabel = (mode: Mode, fileCount: number) => {
	if (mode === 'private') return 'upload privately'
	if (mode === 'create' && fileCount === 0) return 'create empty site'
	return 'deploy ✦'
}

const expiryText = (expiry: Expiry, minutes: string) => {
	if (expiry === 'never') return 'never expires'
	if (expiry === 'custom') return minutes ? `expires in ${minutes} min` : 'expires in … min'
	return 'expires in 7 days'
}

interface Destination {
	text: string
	/** Nothing chosen yet: the text is a placeholder. */
	pending: boolean
}

/** Where the upload will land, shown beside the submit button before anything is sent. */
function destinationFor(
	mode: Mode,
	name: string,
	sites: readonly PublicSite[],
	handle: string,
	expiry: Expiry,
	minutes: string,
): Destination {
	if (mode === 'private') return { text: `private link · ${expiryText(expiry, minutes)}`, pending: false }
	if (mode === 'update') {
		const site = sites.find((candidate) => candidate.rkey === name)
		return site ? { text: siteAddress(site, handle), pending: false } : { text: 'pick a site', pending: true }
	}
	return { text: defaultSiteAddress(handle, name || '…'), pending: !name }
}

export function UploadView({ user }: { user: UserInfo | undefined }) {
	const sites = useSites()
	const publicSites = (sites.data ?? []).filter((site): site is PublicSite => site.kind === 'public')
	const [chosenMode, setMode] = useState<Mode>('update')
	const [name, setName] = useState('')
	const [expiry, setExpiry] = useState<Expiry>('default')
	const [minutes, setMinutes] = useState('')
	const [files, setFiles] = useState<File[]>([])
	const [destination, setDestination] = useState<string | null>(null)
	const client = useQueryClient()
	// Files and fields are kept when an upload fails, so retrying is one click.
	const upload = useUpload(() => {
		client.invalidateQueries({ queryKey: keys.sites })
		setFiles([])
		setName('')
	})

	// Nothing to update yet: start people on a new site instead of an empty picker.
	const mode = chosenMode === 'update' && sites.isSuccess && publicSites.length === 0 ? 'create' : chosenMode
	const busy = upload.state.running
	const handle = user?.handle ?? '…'
	const siteName = name.trim()
	const target = destinationFor(mode, siteName, publicSites, handle, expiry, minutes)

	const chooseMode = (next: Mode) => {
		setMode(next)
		setName('')
	}

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (mode !== 'create' && files.length === 0) {
			notify.error('choose some files first')
			return
		}
		setDestination(mode === 'private' ? null : target.text)
		const size = files.length ? ` · ${plural(files.length, 'file')}, ${formatBytes(totalBytes(files))}` : ''
		upload.start({
			title: `${mode === 'private' ? 'upload --private' : 'deploy'} ${siteName}${size}`,
			body: uploadBody({ mode, name: siteName, expiry, minutes, files }),
			isPrivate: mode === 'private',
		})
	}

	return (
		<Section
			title="upload"
			meta={mode === 'private' ? '100 MB total · kept off your pds' : '200 MB per file · 300 MB total'}
		>
			<form onSubmit={submit} className="mx-auto mt-5 max-w-3xl">
				<fieldset disabled={busy} className="upload-fields">
					<span className="upload-label">mode</span>
					<Segmented label="what to upload" options={MODES} value={mode} onChange={chooseMode} />
					<SiteField mode={mode} sites={sites.isSuccess ? publicSites : null} name={name} onName={setName} />
					{mode === 'private' && (
						<>
							<span className="upload-label">expires</span>
							<div className="flex flex-wrap items-center gap-3">
								<Segmented label="expires after" options={EXPIRIES} value={expiry} onChange={setExpiry} />
								{expiry === 'custom' && (
									<span className="inline-flex items-center gap-2">
										<Input
											aria-label="minutes until it expires"
											className="w-28"
											type="number"
											min={1}
											max={525600}
											step={1}
											required
											value={minutes}
											onChange={(event) => setMinutes(event.target.value)}
										/>
										<span className="text-ink-soft">min</span>
									</span>
								)}
							</div>
						</>
					)}
					<span className="upload-label">files</span>
					<DropZone files={files} onFiles={setFiles} busy={busy} />
				</fieldset>
				<div className="upload-command">
					<span className="text-rose" aria-hidden="true">
						→
					</span>
					<span className={cx('min-w-0 flex-1 truncate', target.pending && 'text-ink-soft')}>{target.text}</span>
					<Button variant="primary" type="submit" busy={busy}>
						{submitLabel(mode, files.length)}
					</Button>
				</div>
			</form>
			{upload.state.title && <UploadLog state={upload.state} destination={destination} />}
		</Section>
	)
}

interface SiteFieldProps {
	mode: Mode
	/** Null until the site list has loaded. */
	sites: PublicSite[] | null
	name: string
	onName: (name: string) => void
}

/** The label/control pair for which site: a picker when updating, a name otherwise. */
function SiteField({ mode, sites, name, onName }: SiteFieldProps) {
	const id = useId()
	const label = (
		<label htmlFor={id} className="upload-label">
			site
		</label>
	)

	if (mode === 'update') {
		return (
			<>
				{label}
				<select
					id={id}
					className="input"
					required
					value={name}
					onChange={(event) => onName(event.target.value)}
					disabled={!sites}
				>
					<option value="" disabled>
						{sites ? 'pick a site…' : 'loading sites…'}
					</option>
					{sites?.map((site) => (
						<option key={site.rkey} value={site.rkey}>
							{site.name}
						</option>
					))}
				</select>
			</>
		)
	}

	return (
		<>
			{label}
			<Input
				id={id}
				required
				placeholder={mode === 'private' ? 'client-preview' : 'my-cool-zine'}
				autoCapitalize="none"
				autoComplete="off"
				spellCheck={false}
				value={name}
				onChange={(event) => onName(event.target.value)}
			/>
		</>
	)
}

interface DropZoneProps {
	files: readonly File[]
	onFiles: (files: File[]) => void
	busy: boolean
}

/** One row that takes a dropped folder, or picks a folder or loose files with its buttons. */
function DropZone({ files, onFiles, busy }: DropZoneProps) {
	const [dragging, setDragging] = useState(false)
	const filePicker = useRef<HTMLInputElement>(null)
	const folderPicker = useRef<HTMLInputElement | null>(null)
	const root = uploadRoot(files)

	const pick = (picked: FileList | null) => {
		if (picked?.length) onFiles(Array.from(picked))
	}

	const drop = async (event: DragEvent) => {
		event.preventDefault()
		setDragging(false)
		if (busy) return
		try {
			const dropped = await droppedFiles(event.dataTransfer.items)
			if (dropped.length) onFiles(dropped)
		} catch {
			notify.error('could not read the dropped folder, try choosing it instead')
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; its buttons cover the keyboard
		<div
			className={cx('dropzone', dragging && 'dropzone-over', files.length > 0 && 'dropzone-full')}
			onDragOver={(event) => {
				event.preventDefault()
				if (!busy) setDragging(true)
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
			}}
			onDrop={drop}
		>
			{files.length ? (
				<span className="min-w-0 flex-1 truncate">
					<span className="text-ok" aria-hidden="true">
						✓{' '}
					</span>
					<span className="font-bold">{root ? `${root}/` : 'loose files'}</span>
					<span className="text-ink-soft">
						{' '}
						· {plural(files.length, 'file')} · {formatBytes(totalBytes(files))}
					</span>
				</span>
			) : (
				<span className="min-w-0 flex-1">
					<span className="text-rose" aria-hidden="true">
						⇣{' '}
					</span>
					drop a folder here <span className="text-ink-soft">or pick one</span>
				</span>
			)}
			<span className="flex shrink-0 gap-1.5">
				<Button onClick={() => folderPicker.current?.click()}>{files.length ? 'change' : 'folder'}</Button>
				{files.length ? (
					<Button variant="ghost" onClick={() => onFiles([])}>
						clear
					</Button>
				) : (
					<Button variant="ghost" onClick={() => filePicker.current?.click()}>
						files
					</Button>
				)}
			</span>
			<input ref={filePicker} type="file" multiple hidden onChange={(event) => pick(event.target.files)} />
			<input
				ref={(input) => {
					// React has no typed prop for directory pickers yet.
					input?.setAttribute('webkitdirectory', '')
					folderPicker.current = input
				}}
				type="file"
				multiple
				hidden
				onChange={(event) => pick(event.target.files)}
			/>
		</div>
	)
}

const statusLine = {
	checking: ['dim', '·', 'checking'],
	uploading: ['dim', '↑', 'uploading'],
	uploaded: ['good', '✓', ''],
	reused: ['dim', '↺', 'unchanged'],
	failed: ['fail', '✗', 'failed'],
} as const

function UploadLog({ state, destination }: { state: UploadState; destination: string | null }) {
	return (
		<div role="log" aria-live="polite" className="terminal mx-auto mt-6 max-w-3xl p-4 text-[0.8rem] leading-relaxed">
			<div>
				<span className="prompt">$</span> {state.title}
			</div>
			{state.running && <ProgressLines state={state} />}
			{state.result && <ResultLines result={state.result} destination={destination} />}
			{state.error && <div className="fail">✗ {state.error}</div>}
		</div>
	)
}

function ProgressLines({ state }: { state: UploadState }) {
	return (
		<>
			<div>
				<span className="dim">◇</span> {state.status}…
			</div>
			{state.recent.map((file) => {
				const [tone, glyph, note] = statusLine[file.status]
				return (
					<div key={file.name} className="truncate pl-4">
						<span className={tone}>{glyph}</span> {file.name} {note && <span className="dim">{note}</span>}
					</div>
				)
			})}
			{state.recent.length === RECENT_FILES && <div className="dim pl-4">…</div>}
		</>
	)
}

const SHOWN_SKIPPED = 5
const SHOWN_FAILED = 10

function ResultLines({ result, destination }: { result: UploadResult; destination: string | null }) {
	const skipped = result.skippedFiles ?? []
	const failed = result.failedFiles ?? []
	const stored = result.uploadedCount || result.fileCount

	return (
		<>
			<div className={failed.length ? 'warn' : 'good'}>
				{failed.length ? '!' : '✓'} done{stored ? ` · ${plural(stored, 'file')} stored` : ''}
				{destination && (
					<>
						{' → '}
						<a href={`https://${destination}`} target="_blank" rel="noopener noreferrer">
							{destination}
						</a>
					</>
				)}
			</div>
			{skipped.slice(0, SHOWN_SKIPPED).map((file) => (
				<div key={file.name} className="dim pl-4">
					skipped {file.name} · {file.reason}
				</div>
			))}
			{skipped.length > SHOWN_SKIPPED && (
				<div className="dim pl-4">…and {skipped.length - SHOWN_SKIPPED} more skipped</div>
			)}
			{failed.slice(0, SHOWN_FAILED).map((file) => (
				<div key={file.name} className="pl-4">
					<span className="fail">✗</span> {file.name} <span className="dim">· {file.error}</span>
				</div>
			))}
			{failed.length > SHOWN_FAILED && <div className="fail pl-4">…and {failed.length - SHOWN_FAILED} more failed</div>}
			{hitPdsSizeLimit(result) && (
				<div className="warn">
					! your pds refused files this large. ask your pds host to raise its upload limit (a cloudflare free-tier proxy
					in front of it can cause this too)
				</div>
			)}
		</>
	)
}
