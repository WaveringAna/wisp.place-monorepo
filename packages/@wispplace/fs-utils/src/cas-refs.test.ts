import { describe, expect, it } from 'bun:test'
import { casKey } from './cas-key'
import { diffCasReferences, distinctCasKeys, normalizeFileObjects } from './cas-refs'

const A = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'bafkreiccccccccccccccccccccccccccccccccccccccccccccccccccccc'

const key = (cid: string, path = 'x.css') => casKey({ cid, path, mimeType: 'text/css' })

describe('normalizeFileObjects', () => {
	it('returns null when nothing is mapped (no column value)', () => {
		expect(normalizeFileObjects(null)).toBeNull()
		expect(normalizeFileObjects(undefined)).toBeNull()
	})

	it('accepts an object of path -> cas key, or its JSON string', () => {
		const objects = { 'a.css': key(A), 'b/c.css': key(B) }
		expect(normalizeFileObjects(objects)).toEqual(objects)
		expect(normalizeFileObjects(JSON.stringify(objects))).toEqual(objects)
	})

	it('keeps an empty mapping as an empty object, distinct from nothing mapped', () => {
		expect(normalizeFileObjects({})).toEqual({})
	})

	it.each([
		['malformed JSON', '{not json'],
		['an array', [['a.css', 'x']]],
		['a number', 7],
		['a string that is not an object', '"x"'],
	])('rejects %s as null so nothing is trusted, never part of it', (_name, value) => {
		expect(normalizeFileObjects(value)).toBeNull()
	})

	it('keeps a hostile "__proto__" path as plain data', () => {
		const objects = normalizeFileObjects(`{"__proto__": "${key(A)}"}`)
		expect(Object.getPrototypeOf(objects)).toBe(Object.prototype)
		expect(Object.keys(objects ?? {})).toEqual(['__proto__'])
	})

	it('rejects the whole mapping when any value is not a cas key', () => {
		// A read must never be steered at an arbitrary storage key such as another site's file.
		expect(normalizeFileObjects({ 'a.css': key(A), 'b.css': 'did:plc:x/site/index.html' })).toBeNull()
		expect(normalizeFileObjects({ 'a.css': key(A), 'b.css': 42 })).toBeNull()
		expect(normalizeFileObjects({ 'a.css': `${key(A)}/../../x` })).toBeNull()
	})
})

describe('distinctCasKeys', () => {
	it('counts a key once per site however many paths use it', () => {
		const shared = key(A)
		expect([...distinctCasKeys({ 'a.css': shared, 'copy/a.css': shared, 'b.css': key(B) })].sort()).toEqual(
			[shared, key(B)].sort(),
		)
	})

	it('is empty for no mapping', () => {
		expect(distinctCasKeys(null).size).toBe(0)
		expect(distinctCasKeys({}).size).toBe(0)
	})
})

describe('diffCasReferences', () => {
	it('takes a reference on every key of a first CAS write', () => {
		const next = { 'a.css': key(A), 'b.css': key(B) }
		const diff = diffCasReferences(null, next)
		expect([...diff.added].sort()).toEqual([key(A), key(B)].sort())
		expect(diff.removed.size).toBe(0)
	})

	it('adds only new keys and releases only dropped ones', () => {
		const diff = diffCasReferences({ 'a.css': key(A), 'b.css': key(B) }, { 'a.css': key(A), 'c.css': key(C) })
		expect([...diff.added]).toEqual([key(C)])
		expect([...diff.removed]).toEqual([key(B)])
	})

	it('does not churn a key that merely moved to another path', () => {
		const diff = diffCasReferences({ 'old.css': key(A) }, { 'new.css': key(A) })
		expect(diff.added.size).toBe(0)
		expect(diff.removed.size).toBe(0)
	})

	it('keeps a key referenced while any path still uses it', () => {
		const diff = diffCasReferences({ 'a.css': key(A), 'b.css': key(A) }, { 'b.css': key(A) })
		expect(diff.removed.size).toBe(0)
	})

	it('releases everything when a CAS site is deleted or goes back to legacy', () => {
		const diff = diffCasReferences({ 'a.css': key(A), 'b.css': key(B) }, null)
		expect([...diff.removed].sort()).toEqual([key(A), key(B)].sort())
		expect(diff.added.size).toBe(0)
	})

	it('is empty when nothing changed', () => {
		const same = { 'a.css': key(A) }
		const diff = diffCasReferences(same, { ...same })
		expect(diff.added.size + diff.removed.size).toBe(0)
	})

	it('never reports a key as both added and removed', () => {
		const diff = diffCasReferences({ 'a.css': key(A), 'b.css': key(B) }, { 'a.css': key(B), 'b.css': key(C) })
		for (const added of diff.added) expect(diff.removed.has(added)).toBe(false)
	})
})
