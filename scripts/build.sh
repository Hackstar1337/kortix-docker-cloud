#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE=${1:?Usage: build.sh /path/to/prepared-upstream [local-image-tag]}
TAG=${2:-kortix-api-docker-cloud:local}
python3 "$HERE/scripts/prepare.py" --target "$SOURCE"
REVISION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream_revision"])' "$HERE/integration.json")
docker build --platform linux/amd64 --build-arg SERVICE=apps/api --build-arg KORTIX_VERSION=0.1.0-rc.1 --build-arg KORTIX_COMMIT="$REVISION" -f "$SOURCE/apps/api/Dockerfile" -t "$TAG" "$SOURCE"
printf 'Built local image %s. No deployment or registry push was performed.\n' "$TAG"
