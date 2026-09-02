// Stubs for the auth client the vendored Komodo types reference.
//
// Komodo's client pulls `mogh_auth_client` from npm for its login surface.
// Nothing in deploy/komodo touches auth — the Action runtime hands us an
// already-authenticated client — so the package is stubbed rather than
// installed. If a script here ever needs `komodo.auth`, install the real
// package instead of widening these.

declare module 'npm:mogh_auth_client' {
	export type LoginRequest = { type: string; params: unknown }
	export type ManageRequest = { type: string; params: unknown }
	export type ExternalLoginProvider = string
	export type LoginResponses = Record<string, unknown>
	export type ManageResponses = Record<string, unknown>
}

declare module 'mogh_auth_client' {
	export * from 'npm:mogh_auth_client'
	export type LoginResponses = Record<string, unknown>
	export type ManageResponses = Record<string, unknown>
}

declare module 'mogh_auth_client/dist/types.js' {
	export * from 'npm:mogh_auth_client'
}
