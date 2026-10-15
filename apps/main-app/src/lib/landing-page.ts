/** The landing page script that sends signed-in visitors to /editor. */
const SIGNED_IN_REDIRECT = /<script data-signed-in-redirect>[\s\S]*?<\/script>/

/** The landing page as /home serves it: signed-in visitors stay on it. */
export function withoutSignedInRedirect(html: string): string {
	return html.replace(SIGNED_IN_REDIRECT, '')
}
