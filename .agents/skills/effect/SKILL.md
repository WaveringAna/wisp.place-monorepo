---
name: effect
description: Write and review Effect 4 Schema code in wisp.place. Use when defining schemas or codecs, validating unknown input, encoding or decoding JSON and AT Protocol boundary data, adding checks, defaults, brands, transformations, recursive types, or typed validation errors, and migrating Schema APIs from Effect 3. Focuses on Schema, not general Effect services or runtime architecture.
---

# Effect 4 Schema

## Workflow and contract

1. Check the installed Effect version and nearby schemas before editing. This guide
   targets `repos/effect` (`@repos/effect` in the request), package version `4.0.0`,
   upstream subtree commit `6389d9ac64c0f62ccc8b575fb9afc65fc104e814` (recorded
   in project commit `714db9fa1734b73f678ff57f818167bbe23c19ae`). Verify APIs
   against that snapshot, not v3 tutorials or remembered signatures.
2. Identify the **wire representation**, **domain representation**, and error
   boundary. Decode untrusted values once at ingress; encode at egress.
3. Define reusable schemas and parser functions at module scope. Derive types from
   schemas; prefer immutable structs and pure combinators. Use classes when
   identity, methods, or yieldable domain errors are useful, not for every DTO.
4. Prefer Effect-returning parsers inside Effect workflows. Keep failures typed;
   do not run Effects or convert failures to exceptions in library helpers.
5. Test both directions, invalid input, optional/default behavior, and any lossy
   normalization. Type-check the code as well as executing it.

This is migration guidance, not permission to add packages or rewrite the app.
Use Bun in this project; add dependencies only when asked. Generated AT Protocol
lexicons remain the wire-contract source of truth. Do not hand-edit generated
files, replace blob/CID types with convenient lookalikes, or change protocol
optionality while migrating. Examples below are small illustrative DTOs, not
complete `place.wisp.*` record validators.

Import public modules from `effect` or `effect/Schema`, `effect/SchemaGetter`, etc.
Some guide snippets use older barrel aliases; check actual exports. Keep vendored
code read-only and never import from `repos/` in application code. Do not copy
library-internal AST construction into application code.

## 1. Common constructors and combinators

| Need | Effect 4 API |
| --- | --- |
| Primitives | `Schema.String`, `Boolean`, `Number`, `BigInt`, `Null`, `Undefined` |
| Safer numbers / strings | `Schema.Finite`, `Schema.Int`, `Schema.NonEmptyString` |
| Literal / enumeration | `Schema.Literal("file")`, `Schema.Literals(["file", "directory"])` |
| Object | `Schema.Struct({ name: Schema.String })` |
| Homogeneous / nonempty array | `Schema.Array(S)`, `Schema.NonEmptyArray(S)` |
| Tuple | `Schema.Tuple([Schema.String, Schema.Int])` |
| Dictionary | `Schema.Record(Schema.String, S)` |
| Union / discriminated variant | `Schema.Union([A, B])`, `Schema.TaggedStruct("File", fields)` |
| Nullable / undefined value | `Schema.NullOr(S)`, `Schema.UndefinedOr(S)` |
| Optional object key | `Schema.optionalKey(S)` (absent), `Schema.optional(S)` (absent or `undefined`) |
| Runtime constraints | `S.check(Schema.isMinLength(1), Schema.isMaxLength(100))` |
| Custom constraint / narrowing | `S.check(Schema.makeFilter(predicate))`, `S.pipe(Schema.refine(typeGuard))` |
| Nominal domain type | `S.pipe(Schema.brand("SiteName"))` after runtime checks |
| Lazy recursion | `Schema.suspend(() => S)` with explicit recursive `Schema.Codec<T, E>` |
| Compose codecs | `A.pipe(Schema.decodeTo(B))` |
| Views without conversion | `Schema.toType(S)`, `Schema.toEncoded(S)` |
| Reverse codec directions | `Schema.flip(S)` |

`Number` accepts `NaN` and infinities. Use `Finite` for ordinary numeric data.
`Int` checks safe integers; add bounds for counts. `NonEmptyString` allows
whitespace-only strings. `brand` distinguishes types, but adds no validation by
itself. `.check` preserves the schema's Type; use `refine` only for actual type
narrowing. Constraints are not transformations.

Struct keys and arrays are readonly by default. Opt into `mutableKey` / `mutable`
only for consumers that require mutation. Reuse `.fields` or `.mapFields(...)`
instead of duplicating structs (see [additional patterns](references/schema-patterns.md)).
Prefer tagged, disjoint unions: ordinary unions select the first successful
member, so overlapping branches can change output when reordered.

## 2. Decode unknown, encode typed values

Adapted from Effect's `ai-docs/.../10_schema-basics.ts`, using a struct DTO:

```ts
import { Effect, Schema } from "effect"

export const SiteSummary = Schema.Struct({
  site: Schema.NonEmptyString,
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.DateFromString
})
export type SiteSummary = typeof SiteSummary.Type
export type SiteSummaryEncoded = typeof SiteSummary.Encoded

export const decodeSite = Schema.decodeUnknownEffect(SiteSummary)
export const encodeSite = Schema.encodeEffect(SiteSummary)

export const roundTripSite = Effect.gen(function*() {
  const site = yield* decodeSite({
    site: "garden",
    fileCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z"
  })
  return yield* encodeSite(site)
})
```

`Type.createdAt` is `Date`; `Encoded.createdAt` is `string`. Encoding validates
and may fail too. Keep existing lexicon `createdAt` strings as strings when the
consumer needs the original representation; conversion is an explicit choice.

| Parser family | Use |
| --- | --- |
| `decodeUnknownEffect(S)(unknown)` | Untrusted ingress; `Effect<T, SchemaError, DecodingServices>` |
| `decodeEffect(S)(encoded)` | Input already typed as `S.Encoded`; still validates |
| `encodeEffect(S)(value)` | Typed domain value; `Effect<E, SchemaError, EncodingServices>` |
| `encodeUnknownEffect(S)(unknown)` | Untrusted domain-side input |
| `decodeUnknownResult` / `encodeResult` | Synchronous explicit success/failure data |
| `decodeUnknownExit` / `encodeExit` | Synchronous outcome including a full failure Cause |
| `decodeUnknownSync` / `encodeSync` | Synchronous schemas only; validation throws |
| `decodeUnknownPromise` / `encodePromise` | Promise-only integration boundary; validation rejects |

Unknown/typed variants exist in each family. Do not cast input just to call the
typed variant. Async schemas need Effect/Promise APIs, not sync/Result/Option/Exit
adapters. Service-dependent schemas need the Effect APIs: provide their required
services before running. Do not erase `DecodingServices` or `EncodingServices`
with casts.

Result and Option adapters handle schema mismatches, **not every failure**:
defects, interruption, and mixed/non-schema causes can still throw. Option also
loses validation details. `SchemaParser` exposes raw `SchemaIssue.Issue` failures;
the normal `Schema` decode/encode APIs wrap them in `Schema.SchemaError`.

### JSON text versus already-parsed JSON

```ts
import { Effect, Schema } from "effect"

export const Settings = Schema.Struct({
  directoryListing: Schema.Boolean,
  cleanUrls: Schema.Boolean,
  indexFiles: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})
export const SettingsJson = Schema.fromJsonString(Settings)
export const roundTripSettings = Effect.gen(function*() {
  const settings = yield* Schema.decodeUnknownEffect(SettingsJson)(
    '{"directoryListing":false,"cleanUrls":true}'
  )
  return yield* Schema.encodeEffect(SettingsJson)(settings)
})
```

Use `Settings` on `request.json()`'s already-parsed value; `SettingsJson` expects
JSON **text** and returns text when encoding. Syntax errors and shape errors both
enter the schema failure channel. `fromJsonString(S)` does not magically make
all runtime values JSON-safe. For canonical representations of `Date`, `BigInt`,
collections, etc., derive `Schema.toCodecJson(S)` first, then wrap in
`fromJsonString` if text is needed. This derivation chooses an encoding; do not
silently substitute it for an existing protocol's wire format.

## 3. Make optionality and excess-key policy explicit

```ts
import { Schema } from "effect"

export const Options = Schema.Struct({
  index: Schema.optionalKey(Schema.String),
  label: Schema.optional(Schema.String),
  fallback: Schema.NullOr(Schema.String)
})
```

- `index` may be absent, but a present `undefined` is invalid.
- `label` may be absent or explicitly `undefined`.
- `fallback` is required, but may be `null`; `NullOr` does not make a key optional.
- These are runtime distinctions even without TS's `exactOptionalPropertyTypes`.
- Extra object keys are **stripped by default**, not rejected. For strict owned
  request DTOs use `Schema.decodeUnknownEffect(S, { onExcessProperty: "error" })`.
  For forward-compatible protocol records, choose intentionally; use a declared
  `Record` / `StructWithRest` if additional fields must be validated and retained.

Decoding defaults and constructor defaults are different; see the reference
before adding one. Never use a fallback to conceal malformed external data.

## 4. Transform deliberately in both directions

For same-type normalization use `Schema.decode`; for a different target schema
use `Schema.decodeTo`. Transformations are reusable values, not plain callback
objects passed directly to `decodeTo`.

Adapted from `SCHEMA.md`'s meters/kilometers and trim examples:

```ts
import { Schema, SchemaTransformation } from "effect"

export const KilometersFromMeters = Schema.Finite.pipe(
  Schema.decode(SchemaTransformation.transform({
    decode: (meters) => meters / 1000,
    encode: (kilometers) => kilometers * 1000
  }))
)
export const Trimmed = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim())
)
export const CountFromString = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
)
```

With `A.pipe(Schema.decodeTo(B, transformation))`:

```text
 decode: A.Encoded -> A.Type -> [transform.decode] -> B.Encoded -> B.Type
 encode: B.Type -> B.Encoded -> [transform.encode] -> A.Type -> A.Encoded
```

Compose reusable transformations with `SchemaTransformation.composeTransformation(a, b)`;
use `encodeTo` / `encode` when expressing the inverse direction is clearer.
Pure, infallible conversions use `SchemaTransformation.transform({ decode,
encode })`. Use built-in codecs (`FiniteFromString`, `URLFromString`,
`DateFromString`) before writing custom ones. Number coercion accepts blank
strings as zero; a strict numeric-text contract needs checks on the **source
string** too. Trimming/lowercasing is lossy: test normalized round trips, not
byte-for-byte preservation, and never normalize AT Protocol identifiers or
paths without an explicit contract.

For fallible or asynchronous conversion use `transformEffect`, or a pair of
`SchemaGetter`s. A getter must fail with **`SchemaIssue.Issue`**, not an arbitrary
domain error. Adapted from the guide's URL example (prefer the built-in in real
code):

```ts
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"

export const CustomUrl = Schema.String.pipe(
  Schema.decodeTo(Schema.instanceOf(URL),
    SchemaTransformation.transformEffect({
      decode: (input, options) => Effect.try({
        try: () => new URL(input),
        catch: () => new SchemaIssue.InvalidValue(
          { message: "Invalid URL string" }, input, options
        )
      }),
      encode: (url) => Effect.succeed(url.href)
    })
  )
)
```

Pass input **and effective options** to custom issues so `reportInput` is
respected. Do not throw inside pure transforms or checks: exceptions are defects,
not typed validation failures. For asynchronous checks and bounded parsing see
[additional patterns](references/schema-patterns.md#effectful-checks-and-concurrency).

## 5. Keep errors structured until the boundary

Adapted from Effect's schema basics example:

```ts
import { Effect, Schema, SchemaIssue } from "effect"

const Payload = Schema.Struct({ site: Schema.NonEmptyString })
const decodePayload = Schema.decodeUnknownEffect(Payload, { errors: "all" })
export const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

export class InvalidSitePayload extends Schema.TaggedError<InvalidSitePayload>()(
  "InvalidSitePayload", { message: Schema.String }
) {}

export const parseSitePayload = Effect.fn("parseSitePayload")((input: unknown) =>
  decodePayload(input).pipe(
    Effect.mapError((error) => new InvalidSitePayload({ message: error.message }))
  )
)
export const decodeForForm = (input: unknown) => decodePayload(input).pipe(
  Effect.mapError((error) => formatIssues(error.issue).issues)
)
```

- `SchemaError.issue` is structured, including paths. `.message` is a formatted
  string; do not parse it to recover fields. Use `makeFormatterStandardSchemaV1`
  for `{ path, message }` issues, or `makeFormatterDefault` for readable text.
- `errors: "all"` accumulates validation issues; default `"first"` stops early.
  Use all-errors for forms and appropriate bounded payloads, not blindly for
  arbitrarily large trees.
- Map validation failures to a `TaggedError` at a meaningful application boundary.
  Use `Effect.catchTag("InvalidSitePayload", ...)` for intentional recovery or an
  HTTP error response. Do not recover with an invalid "success" value or catch
  defects as though they were bad user input.
- `S.make(...)` and `new Schema.Class(...)` construct from the **type-side make
  input**, not wire input, and can throw. `S.makeEffect(...)` keeps construction
  failure typed, but returns a raw **Issue**, not SchemaError; wrap it with
  `Effect.mapError((issue) => new Schema.SchemaError(issue))` when needed.
- Leave `reportInput` off for production payloads containing credentials, tokens,
  or large graphs. Turning it on retains input by reference and can expose it in
  messages/serialization. Custom messages can disclose input even when it is off.

## 6. Avoid Effect 3 APIs and unsafe shortcuts

| Do not copy | Effect 4 replacement |
| --- | --- |
| `Union(A, B)`, `Tuple(A, B)`, `Literal("a", "b")` | `Union([A, B])`, `Tuple([A, B])`, `Literals(["a", "b"])` |
| `Record({ key, value })` | `Record(key, value)` |
| `Schema.decodeUnknown(S)` / `Schema.encode(S)` | `decodeUnknownEffect(S)` / `encodeEffect(S)` |
| `Schema.transform` / `transformOrFail` | `decodeTo` + `SchemaTransformation.transform` / `transformEffect` |
| `filter`, `minLength`, `pattern` | `check(makeFilter(...))`, `check(isMinLength(...))`, `check(isPattern(...))` |
| `parseJson(S)`, `typeSchema(S)`, `encodedSchema(S)` | `fromJsonString(S)`, `toType(S)`, `toEncoded(S)` |
| `validate*` | Decode with `Schema.toType(S)` to validate domain values without wire conversion |
| `Schema.Date` for incoming strings | `Schema.DateFromString`; v4 `Date` expects a Date object |
| `annotations(...)`, curried `asserts(S)(input)` | `annotate(...)`, `asserts(S, input)` |

Avoid `as T`/`any` as validation, `disableChecks: true` on untrusted data,
reconstructing schemas per request, async predicates in `.check`, implicit
fallbacks, and unbounded concurrency by default. Keep deterministic checks free
of side effects. Do not enable experimental JIT/AOT compilation as part of a
routine schema migration.

## Verification and source map

For each schema test: valid decode, valid encode, malformed input, invalid domain
value, missing/null/undefined fields, excess keys, defaults, and round-trip laws.
Use `bun test --isolate <test-file>` (never bare `bun test`), `bun check`, and
`biome check --write` on changed TypeScript. See the reference for a Bun test.
No additional testing package is required.

Sources reviewed in the pinned checkout (paths relative to repository root):

- [Schema guide](../../../repos/effect/packages/effect/SCHEMA.md): elementary and
  composite schemas; defaults; transformations; serialization; parsing options;
  error handling. Check the implementation if a guide snippet conflicts.
- [v3 migration map](../../../repos/effect/migration/schema.md).
- [Schema basics](../../../repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts):
  cached parsers, Class, TaggedError, mapError.
- [Schema.ts](../../../repos/effect/packages/effect/src/Schema.ts): `makeEffect`
  (244–270), SchemaError (1135–1213), parser APIs (1453–2235), optionals
  (2270–2379), decodeTo (5389–5492), NumberFromString (9867–9913).
- [Runtime tests](../../../repos/effect/packages/effect/test/schema/Schema.test.ts):
  optionals (823–902), coercion (2094–2315), composition (2318–2450),
  makeEffect (3689–3728), constructor defaults (3731 onward), decoding defaults
  (9672 onward). [Parser tests](../../../repos/effect/packages/effect/test/schema/SchemaParser.test.ts)
  cover concurrency (67 onward) and failure behavior.
- [Type tests](../../../repos/effect/packages/effect/typetest/schema/Schema.tst.ts),
  [getter tests](../../../repos/effect/packages/effect/test/schema/SchemaGetter.test.ts),
  and [transformation tests](../../../repos/effect/packages/effect/test/schema/SchemaTransformation.test.ts).
