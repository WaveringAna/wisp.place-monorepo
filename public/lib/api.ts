import { treaty } from '@elysiajs/eden'

import type { app } from '@server'

// Use the current host instead of hardcoded localhost
const apiHost = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000'

export const api = treaty<typeof app>(apiHost)
