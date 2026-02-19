# @wispplace/lexicons

Shared AT Protocol lexicon definitions and generated TypeScript types for the wisp.place project.

## Contents

- `/lexicons` - Source lexicon JSON definitions
- `/src/types` - Generated TypeScript types and validators (`@atproto/lex-cli`)
- `/src/atcute` - Generated atcute bindings (`@atcute/lex-cli`)

## Usage

```typescript
import { ids, lexicons } from '@wispplace/lexicons';
import type { PlaceWispFs } from '@wispplace/lexicons/types/place/wisp/fs';
import { PlaceWispV2DomainClaim } from '@wispplace/lexicons/atcute';
```

## Code Generation

To regenerate types from lexicon definitions:

```bash
bun run codegen
bun run codegen:atcute
```

From monorepo root you can run both with:

```bash
bun run scripts/codegen.sh
```

Generation uses:

- `@atproto/lex-cli` for `src/types`
- `@atcute/lex-cli` for `src/atcute`
