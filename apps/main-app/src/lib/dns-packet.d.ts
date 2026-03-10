declare module 'dns-packet' {
	export type RecordType = 'A' | 'NS' | 'TXT' | 'CNAME'

	export interface Question {
		type: RecordType
		name: string
		class?: 'IN'
	}

	export interface Answer {
		type: RecordType
		name: string
		data?: string | string[] | Buffer | Buffer[]
	}

	export interface Packet {
		type: 'query' | 'response'
		id?: number
		flags?: number
		questions?: Question[]
		answers?: Answer[]
		additionals?: Answer[]
	}

	export function encode(packet: Packet): Buffer
	export function decode(buffer: Buffer): Packet
}
