#!/bin/sh
set -eu

compose() {
	docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile dev "$@"
}

case "${1:-up}" in
	up)
		compose up -d postgres redis minio-create-bucket pds-init
		if ! compose wait minio-create-bucket pds-init; then
			compose logs --no-color minio-create-bucket pds-init
			exit 1
		fi
		compose up -d --wait postgres redis minio plc-postgres plc maildev pds
		;;
	down)
		compose down
		;;
	*)
		printf 'usage: %s [up|down]\n' "$0" >&2
		exit 2
		;;
esac
