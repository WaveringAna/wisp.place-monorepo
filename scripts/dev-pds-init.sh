#!/bin/sh
set -eu

umask 077
apk add --no-cache curl jq >/dev/null 2>&1

log() {
	printf '[pds-init] %s\n' "$*" >&2
}

login() {
	handle="$1"
	password="$2"
	curl -fsS -X POST "$PDS_URL/xrpc/com.atproto.server.createSession" \
		-H 'Content-Type: application/json' \
		-d "{\"identifier\":\"$handle\",\"password\":\"$password\"}" 2>/dev/null
}

create_invite() {
	curl -fsS -X POST "$PDS_URL/xrpc/com.atproto.server.createInviteCode" \
		-H 'Content-Type: application/json' \
		-H "Authorization: Basic $(printf 'admin:%s' "$PDS_ADMIN_PASSWORD" | base64)" \
		-d '{"useCount":10}' | jq -er '.code'
}

ensure_account() {
	handle="$1"
	password="$2"
	email="$3"

	if session="$(login "$handle" "$password")"; then
		printf '%s' "$session"
		return
	fi

	log "creating $handle"
	invite_code="${INVITE_CODE:-}"
	if [ -z "$invite_code" ]; then
		INVITE_CODE="$(create_invite)"
		invite_code="$INVITE_CODE"
	fi

	curl -fsS -X POST "$PDS_URL/xrpc/com.atproto.server.createAccount" \
		-H 'Content-Type: application/json' \
		-d "{\"handle\":\"$handle\",\"email\":\"$email\",\"password\":\"$password\",\"inviteCode\":\"$invite_code\"}"
}

existing_app_password=''
if [ -f /devnet-data/accounts.env ]; then
	existing_app_password="$(sed -n 's/^ALICE_APP_PASSWORD=//p' /devnet-data/accounts.env | head -n 1)"
fi

alice_session="$(ensure_account "$ALICE_HANDLE" "$ALICE_PASSWORD" 'alice@example.test')"
bob_session="$(ensure_account "$BOB_HANDLE" "$BOB_PASSWORD" 'bob@example.test')"

alice_did="$(printf '%s' "$alice_session" | jq -er '.did')"
bob_did="$(printf '%s' "$bob_session" | jq -er '.did')"
alice_access="$(printf '%s' "$alice_session" | jq -er '.accessJwt')"

alice_app_password="$existing_app_password"
if [ -z "$alice_app_password" ] || ! login "$ALICE_HANDLE" "$alice_app_password" >/dev/null; then
	log 'creating alice app password'
	alice_app_password="$(curl -fsS -X POST "$PDS_URL/xrpc/com.atproto.server.createAppPassword" \
		-H 'Content-Type: application/json' \
		-H "Authorization: Bearer $alice_access" \
		-d '{"name":"wisp-dev"}' | jq -er '.password')"
fi

mkdir -p /devnet-data
output="$(mktemp /devnet-data/accounts.env.XXXXXX)"
cat >"$output" <<EOF
E2E_ATPROTO_HANDLE=$ALICE_HANDLE
E2E_ATPROTO_PASSWORD=$ALICE_PASSWORD
ALICE_HANDLE=$ALICE_HANDLE
ALICE_DID=$alice_did
ALICE_PASSWORD=$ALICE_PASSWORD
ALICE_APP_PASSWORD=$alice_app_password
BOB_HANDLE=$BOB_HANDLE
BOB_DID=$bob_did
BOB_PASSWORD=$BOB_PASSWORD
EOF
mv "$output" /devnet-data/accounts.env

log "ready: $ALICE_HANDLE ($alice_did), $BOB_HANDLE ($bob_did)"
