import { randomBytes, randomInt } from 'node:crypto'

export const PRIVATE_STORAGE_PREFIX = 'private'
const SITE_ID_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[0-9]{4}$/
const ADJECTIVES =
	'amber ancient autumn bashful bitter blooming bouncy brave bright brisk calm candid cheerful chilly chubby clever cloudy cosmic cozy crimson crisp curious dainty dapper dawn dazzling deft dewy downy dreamy dusky eager earnest elegant ember fabled faded fancy feathery fearless fizzy fleecy floral fluffy foggy frosty gentle giddy gilded glassy gleaming glowing golden graceful grassy hazy hearty hidden honest humble hushed ivory jolly jovial'.split(
		' ',
	)
const NOUNS =
	'acorn anchor apple arbor arrow aspen badger basket beacon beetle bellow birch bison blossom bluebird bonfire boulder bramble breeze brook bubble bunny burrow button cactus candle canoe canyon cavern cedar cherry chestnut clover comet compass coral cottage cricket crocus crystal daisy dolphin donkey dragon dumpling eagle ember fable falcon fawn fennel fern ferret fiddle finch firefly fjord flamingo forest fossil fountain foxglove galaxy garden'.split(
		' ',
	)
const ANIMALS =
	'axolotl badger bat bear beaver bee bison boar bunny camel capybara caribou cat chameleon cheetah chinchilla chipmunk cobra coyote crab crane cricket crow deer dingo dodo dog dolphin donkey dormouse dove duck eagle eel egret elk falcon ferret finch fox frog gecko gerbil gibbon giraffe goat goose gopher grouse guppy hamster hare hawk hedgehog heron hippo hornet horse ibex ibis iguana impala jackal jaguar'.split(
		' ',
	)

const pick = (words: string[]): string => words[randomInt(words.length)]!

// The hostname is readable, not secret. The database retries the rare collision.
export const generateSiteId = (): string =>
	`${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(ANIMALS)}-${randomInt(10_000).toString().padStart(4, '0')}`

export const generateRecordId = (): string => randomBytes(8).toString('hex')

export const isValidSiteId = (siteId: string): boolean => siteId.length <= 63 && SITE_ID_PATTERN.test(siteId)

export const buildPrivateStorageKey = (siteId: string, filePath: string): string => {
	if (!isValidSiteId(siteId)) {
		throw new Error('invalid private site id')
	}
	const normalized = filePath.replace(/^\/+/, '')
	return `${PRIVATE_STORAGE_PREFIX}/${siteId}/${normalized}`
}

export const privateResponseHeaders = (): Record<string, string> => ({
	'Cache-Control': 'no-store, no-cache, must-revalidate, private',
	Pragma: 'no-cache',
	'Referrer-Policy': 'no-referrer',
	'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
})
