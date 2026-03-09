/**
 * Default JSON serializer.
 *
 * @param data - Data to serialize (must be JSON-serializable)
 * @returns Serialized data as Uint8Array (UTF-8 encoded JSON)
 *
 * @remarks
 * This is the default serializer used if no custom serializer is provided.
 * Handles most JavaScript types but cannot serialize:
 * - Functions
 * - Symbols
 * - undefined values (they become null)
 * - Circular references
 *
 * @example
 * ```typescript
 * const data = { name: 'Alice', age: 30 };
 * const serialized = await defaultSerialize(data);
 * ```
 */
export async function defaultSerialize(data: unknown): Promise<Uint8Array> {
	const json = JSON.stringify(data)
	return new TextEncoder().encode(json)
}

/**
 * Default JSON deserializer.
 *
 * @param data - Serialized data (UTF-8 encoded JSON)
 * @returns Deserialized data
 * @throws SyntaxError if data is not valid JSON
 *
 * @remarks
 * This is the default deserializer used if no custom deserializer is provided.
 * Parses UTF-8 encoded JSON back to JavaScript objects.
 *
 * @example
 * ```typescript
 * const data = await defaultDeserialize(serialized);
 * console.log(data.name); // 'Alice'
 * ```
 */
export async function defaultDeserialize(data: Uint8Array): Promise<unknown> {
	const json = new TextDecoder().decode(data)
	return JSON.parse(json)
}
