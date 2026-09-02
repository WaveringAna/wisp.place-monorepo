// The globals Komodo injects into an Action script.
//
// Komodo wraps an Action's file contents in a preamble that imports its
// client, declares `ARGS` from the request, and puts the body inside
// `async function main()`. None of that is visible in the file itself, so
// these declarations stand in for it and let the Actions be type-checked
// here rather than only in Komodo's editor.
//
// Keep in step with Komodo's wrapper (bin/core/src/api/execute/action.rs).
// The client types under vendor/ are fetched from a running Komodo:
//   curl https://<komodo>/client/{types,lib,responses,terminal}.d.ts

import type { KomodoClient } from './vendor/lib.js'
import type * as KomodoTypes from './vendor/types.js'

declare global {
	/** Arguments merged from the Action's defaults and the RunAction request. */
	const ARGS: Record<string, unknown>

	/** Pre-authenticated client. Actions get one; no keys are configured. */
	const komodo: ReturnType<typeof KomodoClient>

	// `export import` so `Types` works as both a value and a type
	// namespace — `Types.Version` as an annotation, `Types.SomeEnum` as a
	// value, exactly as it behaves inside Komodo.
	export import Types = KomodoTypes

	const YAML: {
		stringify(value: unknown): string
		parse(text: string): unknown
		parseAll(text: string): unknown[]
		parseDockerCompose(text: string): unknown
	}

	const TOML: {
		stringify(value: unknown): string
		parse(text: string): unknown
		parseResourceToml(text: string): unknown
		parseCargoToml(text: string): unknown
	}
}

export {}
