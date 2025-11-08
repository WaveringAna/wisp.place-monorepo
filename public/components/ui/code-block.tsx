import ShikiHighlighter from 'react-shiki'

interface CodeBlockProps {
	code: string
	language?: string
	className?: string
}

export function CodeBlock({ code, language = 'bash', className = '' }: CodeBlockProps) {
	return (
		<ShikiHighlighter
			language={language}
			theme={{
				light: 'catppuccin-latte',
				dark: 'catppuccin-mocha',
			}}
			defaultColor="light-dark()"
			className={className}
		>
			{code.trim()}
		</ShikiHighlighter>
	)
}
