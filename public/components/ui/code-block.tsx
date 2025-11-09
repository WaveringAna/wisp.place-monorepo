import { useEffect, useRef, useState } from 'react'

declare global {
	interface Window {
		Prism: {
			languages: Record<string, any>
			highlightElement: (element: HTMLElement) => void
			highlightAll: () => void
		}
	}
}

interface CodeBlockProps {
	code: string
	language?: 'bash' | 'yaml'
	className?: string
}

export function CodeBlock({ code, language = 'bash', className = '' }: CodeBlockProps) {
	const [isThemeLoaded, setIsThemeLoaded] = useState(false)
	const codeRef = useRef<HTMLElement>(null)

	useEffect(() => {
		// Load Catppuccin theme CSS
		const loadTheme = async () => {
			// Detect if user prefers dark mode
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
			const theme = prefersDark ? 'mocha' : 'latte'

			// Remove any existing theme CSS
			const existingTheme = document.querySelector('link[data-prism-theme]')
			if (existingTheme) {
				existingTheme.remove()
			}

			// Load the appropriate Catppuccin theme
			const link = document.createElement('link')
			link.rel = 'stylesheet'
			link.href = `https://prismjs.catppuccin.com/${theme}.css`
			link.setAttribute('data-prism-theme', theme)
			document.head.appendChild(link)

			// Load PrismJS if not already loaded
			if (!window.Prism) {
				const script = document.createElement('script')
				script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.30.0/prism.min.js'
				script.onload = () => {
					// Load language support if needed
					if (language === 'yaml' && !window.Prism.languages.yaml) {
						const yamlScript = document.createElement('script')
						yamlScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.30.0/components/prism-yaml.min.js'
						yamlScript.onload = () => setIsThemeLoaded(true)
						document.head.appendChild(yamlScript)
					} else {
						setIsThemeLoaded(true)
					}
				}
				document.head.appendChild(script)
			} else {
				setIsThemeLoaded(true)
			}
		}

		loadTheme()

		// Listen for theme changes
		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
		const handleThemeChange = () => loadTheme()
		mediaQuery.addEventListener('change', handleThemeChange)

		return () => {
			mediaQuery.removeEventListener('change', handleThemeChange)
		}
	}, [language])

	// Highlight code when Prism is loaded and component is mounted
	useEffect(() => {
		if (isThemeLoaded && codeRef.current && window.Prism) {
			window.Prism.highlightElement(codeRef.current)
		}
	}, [isThemeLoaded, code])

	if (!isThemeLoaded) {
		return (
			<pre className={`p-4 bg-muted rounded-lg overflow-x-auto ${className}`}>
				<code>{code.trim()}</code>
			</pre>
		)
	}

	// Map language to Prism language class
	const languageMap = {
		'bash': 'language-bash',
		'yaml': 'language-yaml'
	}

	const prismLanguage = languageMap[language] || 'language-bash'

	return (
		<pre className={`p-4 rounded-lg overflow-x-auto ${className}`}>
			<code ref={codeRef} className={prismLanguage}>{code.trim()}</code>
		</pre>
	)
}
