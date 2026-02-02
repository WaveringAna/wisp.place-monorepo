# @wisp/lexicons

Shared AT Protocol lexicon definitions and generated TypeScript types for the wisp.place project.

## Contents

- `/lexicons` - Source lexicon JSON definitions
- `/src` - Generated TypeScript types and validation functions

## Usage

```typescript
import { ids, lexicons } from '@wisp/lexicons';
import type { PlaceWispFs } from '@wisp/lexicons/types/place/wisp/fs';
```

## Code Generation

To regenerate types from lexicon definitions:

```bash
npm run codegen
```

This uses `@atproto/lex-cli` to generate TypeScript types from the JSON schemas in `/lexicons`.
