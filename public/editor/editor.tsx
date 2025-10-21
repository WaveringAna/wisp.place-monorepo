import { useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import Layout from '@public/layouts'

function Editor() {
	const [uploading, setUploading] = useState(false)
	const [result, setResult] = useState<any>(null)
	const [error, setError] = useState<string | null>(null)
	const folderInputRef = useRef<HTMLInputElement>(null)
	const siteNameRef = useRef<HTMLInputElement>(null)

	const handleFileUpload = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setResult(null)

		const files = folderInputRef.current?.files
		const siteName = siteNameRef.current?.value

		if (!files || files.length === 0) {
			setError('Please select a folder to upload')
			return
		}

		if (!siteName) {
			setError('Please enter a site name')
			return
		}

		setUploading(true)

		try {
			const formData = new FormData()
			formData.append('siteName', siteName)
			
			for (let i = 0; i < files.length; i++) {
				formData.append('files', files[i])
			}

			const response = await fetch('/wisp/upload-files', {
				method: 'POST',
				body: formData
			})

			if (!response.ok) {
				throw new Error(`Upload failed: ${response.statusText}`)
			}

			const data = await response.json()
			setResult(data)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Upload failed')
		} finally {
			setUploading(false)
		}
	}

	return (
		<div className="w-full max-w-2xl mx-auto p-6">
			<h1 className="text-3xl font-bold mb-6 text-center">Upload Folder</h1>
			
			<form onSubmit={handleFileUpload} className="space-y-4">
				<div>
					<label htmlFor="siteName" className="block text-sm font-medium mb-2">
						Site Name
					</label>
					<input
						ref={siteNameRef}
						type="text"
						id="siteName"
						placeholder="Enter site name"
						className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
					/>
				</div>

				<div>
					<label htmlFor="folder" className="block text-sm font-medium mb-2">
						Select Folder
					</label>
					<input
						ref={folderInputRef}
						type="file"
						id="folder"
						{...({ webkitdirectory: '', directory: '' } as any)}
						multiple
						className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
					/>
				</div>

				<button
					type="submit"
					disabled={uploading}
					className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-md transition-colors"
				>
					{uploading ? 'Uploading...' : 'Upload Folder'}
				</button>
			</form>

			{error && (
				<div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-md">
					{error}
				</div>
			)}

			{result && (
				<div className="mt-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded-md">
					<h3 className="font-semibold mb-2">Upload Successful!</h3>
					<p>Files uploaded: {result.fileCount}</p>
					<p>Site name: {result.siteName}</p>
					<p>URI: {result.uri}</p>
				</div>
			)}
		</div>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<Editor />
	</Layout>
)