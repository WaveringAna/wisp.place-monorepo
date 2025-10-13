import { treaty } from '@elysiajs/eden'

import type { app } from '../../src'

export const api = treaty<typeof app>('localhost:3000')
