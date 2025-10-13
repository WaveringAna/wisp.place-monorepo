import { createRoot } from 'react-dom/client'
import { useQuery } from '@tanstack/react-query'

import Layout from '../layouts'
import { api } from '../libs/api'

function App() {
	const { data: response, isLoading } = useQuery({
		queryKey: ['version'],
		queryFn: () => api.message.get()
	})

	return (
		<>
			<img src="/images/maddelena-2.webp" className="max-w-40" />
			<h1 className="text-3xl">API call!</h1>
			<h2 className="text-6xl">{response?.data?.message}</h2>
		</>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<App />
	</Layout>
)
