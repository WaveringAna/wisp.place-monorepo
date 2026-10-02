# Additional Schema patterns

Read this when the main skill's basic codecs are not enough. Examples are adapted
from `repos/effect/packages/effect/SCHEMA.md` and its runtime tests at the commit
recorded in [SKILL.md](../SKILL.md).

## Defaults: wire versus construction

```ts
import { Effect, Schema } from "effect"

export const Page = Schema.Struct({
  size: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("20"))
  )
})
export const LocalPage = Schema.Struct({
  size: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(20)))
})
```

- `Page` decodes `{}` to `{ size: 20 }`; `{ size: undefined }` is invalid. The
  default is an **Encoded** string and is decoded normally.
- `withDecodingDefault` also accepts present `undefined`; the `Key` variant only
  fills an absent key. Neither is a fallback for malformed present values.
- `withDecodingDefaultTypeKey` / `withDecodingDefaultType` accept a decoded Type
  default instead. That default bypasses the field's decoding transformation.
- The default is an Effect, not a callback or raw value. Default Effects that
  need services must be provided when parsing with Effect APIs.
- Decoding-default encoding includes the value by default. The explicit
  `{ encodingStrategy: "omit" }` option omits that key during encoding, not just
  when it equals the default; use only for an intentional wire contract.
- `LocalPage.make({})` fills the constructor default. Decoding `{}` against
  `LocalPage` still fails: constructor defaults do not supply missing wire data.
  Constructors use type-side values, not `FiniteFromString`'s encoded strings.

For custom missing-key logic, `SchemaGetter.transformOptional` /
`transformOptionalEffect` work on `Option` values: `None` means an absent key,
not a present `undefined`. `SchemaGetter.omit()` is suitable only when the
encoded field permits omission. Prefer the default helpers for ordinary defaults.

Source: guide “Decoding Defaults” / “Default Values in Constructors”;
`test/schema/Schema.test.ts` “withDecodingDefaultKey” and “withConstructorDefault”.

## Reuse structs and report cross-field errors

```ts
import { Schema, Struct } from "effect"

export const BaseSettings = Schema.Struct({
  directoryListing: Schema.Boolean,
  cleanUrls: Schema.Boolean
})
export const ListingSettings = BaseSettings.mapFields(
  Struct.pick(["directoryListing"])
)
export const UpdateSettings = BaseSettings.mapFields(Struct.map(Schema.optionalKey))

export const ConfirmedName = Schema.Struct({
  name: Schema.NonEmptyString,
  confirmation: Schema.NonEmptyString
}).check(Schema.makeFilter((value) =>
  value.name === value.confirmation
    ? undefined
    : { path: ["confirmation"], issue: "Names must match" }
))
```

Use `.fields` to share individual field schemas. Derived structs may discard
object-level checks whose assumptions no longer hold; inspect `.mapFields`'s
contract and reapply appropriate checks rather than using
`unsafePreserveChecks` to suppress the problem.

A filter returns `true`/`undefined` for success, `false`/a string for failure, or
`{ path, issue }` / an array of issues for structured failure. A string is always
an **error message**, not a truthy success value. Prefer built-in checks for
ordinary bounds and formats. An identifier annotation names a type mismatch;
use a filter's `expected` or `message` annotation to label a failed check.

Source: guide “Deriving Structs” / “Validation”; Schema tests “mapFields”,
“makeFilter”, and “check”.

## Recursive trees

Use lazy edges, not eager self-references or `any`. For wisp's directory trees,
reuse the generated lexicon contracts and treat subfs AT-URIs as references;
Schema recursion does not fetch or resolve those records.

Adapted from the guide's recursive Category example:

```ts
import { Schema } from "effect"

export interface DirectoryTree {
  readonly name: string
  readonly children: ReadonlyArray<DirectoryTree>
}
export const DirectoryTree: Schema.Codec<DirectoryTree> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<DirectoryTree> => DirectoryTree))
})
```

`Schema.Codec<T>` assumes `Encoded = T`. Supply `Schema.Codec<T, E>` and separate
recursive interfaces if the wire shape differs (e.g. strings becoming dates).
Decode size/depth limits should match the hosting contract; recursion alone
neither limits depth nor prevents hostile large trees or cyclic JS inputs.

Source: guide “Recursive Schemas”; runtime tests “suspend”; type tests for Codec.

## Classes when they add value

Adapted from Effect's `ai-docs/src/01_effect/02_schema/10_schema-basics.ts`:

```ts
import { Schema } from "effect"

export class User extends Schema.Class<User>("wisp/example/User")({
  id: Schema.Int,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"])
}) {}
export const decodeUser = Schema.decodeUnknownEffect(User)
export const encodeUser = Schema.encodeEffect(User)
```

Decoding constructs a User instance; encoding produces its wire fields. Use
`User.makeEffect(...)` for typed construction failures. The class identifier
should be stable and module-qualified. Avoid class wrappers for simple immutable
request DTOs unless instance identity or methods actually help.

## Effectful checks and concurrency

Async validation is a Getter in the decoding path, not an async `.check`
predicate. Adapted from guide “Effectful Filters” / “Concurrent Product Parsing”:

```ts
import { Effect, Schema, SchemaGetter } from "effect"

export const CheckedName = Schema.NonEmptyString.pipe(Schema.decode({
  decode: SchemaGetter.checkEffect((name) => Effect.succeed(
    name !== "reserved" || "Name is reserved"
  )),
  encode: SchemaGetter.passthrough()
}))
export const decodeNames = Schema.decodeUnknownEffect(Schema.Array(CheckedName))
export const parseNames = (input: unknown) => decodeNames(input, { concurrency: 4 })
```

The trivial check illustrates the API; a pure predicate like this should normally
be `.check(makeFilter(...))`. Use `checkEffect` for real async/service-dependent
checks; map expected service errors to schema issues if they belong to validation,
and keep operational failures in the service layer when they do not.

Concurrency defaults to sequential. A bound applies **independently to each
nested product**, not globally across the request. Struct fields, tuples, arrays,
and record entries can run concurrently; union branches remain sequential.
Arrays retain their positions, but side effects and all-error diagnostics follow
completion order. First-error mode interrupts remaining child work, not effects
already performed. Transformed record-key collisions are completion-order
last-wins. Avoid effects with externally visible mutations in validation, and
never assume parallel parsing is transactional.

Source: `SCHEMA.md` “Parsing Options”; `SchemaParser.test.ts` “product concurrency”.

## Bun test idiom

Adapted from Effect tests' separate decoding/encoding assertions; use this
project's existing Bun runner rather than adding `@effect/vitest`:

```ts
import { expect, test } from "bun:test"
import { Effect, Result, Schema, SchemaIssue } from "effect"

const Count = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int))

test("count codec validates both sides", async () => {
  const value = await Effect.runPromise(Schema.decodeUnknownEffect(Count)("2"))
  expect(value).toBe(2)
  expect(await Effect.runPromise(Schema.encodeEffect(Count)(value))).toBe("2")

  const result = Schema.decodeUnknownResult(Count)("invalid")
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.length)
      .toBeGreaterThan(0)
  }
  expect(Result.isFailure(Schema.encodeResult(Count)(1.5))).toBe(true)
})
```

Run `bun test --isolate <file>` and `bun check`. Add separate tests for optionality,
defaults, excess keys, and round-trip normalization. For asynchronous parsing,
assert start/finish behavior with controlled synchronization rather than elapsed
wall time; see upstream `SchemaParser.test.ts`'s Deferred-based concurrency tests.
Do not assert one deterministic error order when children run concurrently.
