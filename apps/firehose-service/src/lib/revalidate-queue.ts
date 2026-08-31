/**
 * Values carried in the revalidation stream's `reason` field.
 *
 * These must stay stable while messages can remain pending in Redis across
 * deployments.
 */
export const SITE_DELETE_TOMBSTONE_REASON = 'firehose-delete-tombstone'

export function isSiteDeleteTombstoneReason(reason: string): boolean {
	return reason === SITE_DELETE_TOMBSTONE_REASON
}

export const SETTINGS_UPDATE_FAILURE_REASON = 'firehose-settings-failed:update'
export const SETTINGS_DELETE_FAILURE_REASON = 'firehose-settings-failed:delete'

export function isSettingsFailureRevalidationReason(reason: string): boolean {
	return reason === SETTINGS_UPDATE_FAILURE_REASON || reason === SETTINGS_DELETE_FAILURE_REASON
}
