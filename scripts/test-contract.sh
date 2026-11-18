#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE=${1:?Usage: test-contract.sh /path/to/prepared-upstream}
[ -f "$SOURCE/.kortix-docker-cloud-integration.json" ] || { echo 'Prepare and verify pinned source first.' >&2; exit 1; }
python3 "$HERE/scripts/prepare.py" --target "$SOURCE"
TAG=kortix-docker-cloud-contract:local
docker build --platform linux/amd64 -f "$HERE/ci/Dockerfile.contract" -t "$TAG" "$SOURCE"
docker run --rm --network none "$TAG"
