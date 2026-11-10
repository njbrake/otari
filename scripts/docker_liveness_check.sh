#!/usr/bin/env bash
#
# Liveness check for the gateway Docker image.
# Checks `otari --version`, starts PostgreSQL, runs the gateway container, and
# validates health endpoints.
#
# Usage: ./scripts/docker_liveness_check.sh <image_tag>
# Example: ./scripts/docker_liveness_check.sh otari-test:abc123
#

set -euo pipefail

IMAGE_TAG="${1:-}"

if [[ -z "$IMAGE_TAG" ]]; then
    echo "Usage: $0 <image_tag>"
    echo "Example: $0 otari-test:latest"
    exit 1
fi

POSTGRES_CONTAINER="test-postgres"
OTARI_CONTAINER="test-otari"
CONFIG_FILE="/tmp/otari-config.yml"

cleanup() {
    echo "Cleaning up containers..."
    docker rm -f "$OTARI_CONTAINER" "$POSTGRES_CONTAINER" 2>/dev/null || true
}

trap cleanup EXIT

# The build context excludes .git (.dockerignore), so setuptools-scm has no tag
# to read and otari_agent.__version__ is its 0.0.0 fallback; `otari --version`
# reports OTARI_VERSION instead, the image's own ENV and the value the gateway
# reports. Compared inside the container, so the script needs no copy of the
# build argument.
echo "Testing otari --version reports the image version..."
docker run --rm "$IMAGE_TAG" sh -c '
    expected="otari, version $OTARI_VERSION"
    actual="$(otari --version)"
    echo "$actual"
    if [ "$actual" != "$expected" ]; then
        echo "Expected \"$expected\": the CLI did not pick up OTARI_VERSION"
        exit 1
    fi
'

echo "Starting PostgreSQL container..."
docker run -d --name "$POSTGRES_CONTAINER" \
    -e POSTGRES_USER=otari \
    -e POSTGRES_PASSWORD=otari \
    -e POSTGRES_DB=otari \
    -p 5432:5432 \
    postgres:16-alpine

echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U otari > /dev/null 2>&1; then
        echo "PostgreSQL is ready"
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "PostgreSQL failed to become ready"
        docker logs "$POSTGRES_CONTAINER"
        exit 1
    fi
    sleep 1
done

echo "Creating gateway config..."
cat > "$CONFIG_FILE" << 'EOF'
database_url: "postgresql://otari:otari@host.docker.internal:5432/otari"
host: "0.0.0.0"
port: 8000
master_key: "test-master-key"
EOF

echo "Starting gateway container with image: $IMAGE_TAG"
# Provider copies are on by default, and the gateway refuses to serve without a
# pepper of its own. Generated per run, as a deployment would set one.
docker run -d --name "$OTARI_CONTAINER" \
    --add-host=host.docker.internal:host-gateway \
    -e OTARI_PROVIDER_ACCOUNT_PEPPER="$(openssl rand -base64 32)" \
    -e OTARI_DEBUG_MEMORY=true \
    -p 8000:8000 \
    -v "$CONFIG_FILE":/app/config.yml \
    "$IMAGE_TAG" \
    otari serve --config /app/config.yml

echo "Waiting for gateway to be healthy..."
for i in {1..60}; do
    if curl -sf http://localhost:8000/api/v1/health > /dev/null 2>&1; then
        echo "Gateway is responding"
        break
    fi
    if [[ $i -eq 60 ]]; then
        echo "Gateway failed to become healthy within 60 seconds"
        echo "=== Gateway logs ==="
        docker logs "$OTARI_CONTAINER"
        exit 1
    fi
    sleep 1
done

echo "Testing /api/v1/health endpoint..."
curl -sf http://localhost:8000/api/v1/health
echo ""

echo "Testing /api/v1/health/liveness endpoint..."
curl -sf http://localhost:8000/api/v1/health/liveness
echo ""

echo "Testing /api/v1/health/readiness endpoint..."
curl -sf http://localhost:8000/api/v1/health/readiness
echo ""

# The dashboard bundle is not committed: the Dockerfile's web stage builds it and
# the runtime stage copies it in. A bundle that never reached the image is not an
# error at boot, it silently degrades to the get-started tutorial at "/", so this
# has to be asserted rather than inferred from a healthy process.
#
# /dashboard-build.json is the signal, not the page text: the route is registered
# only inside the branch that found a bundle (src/gateway/main.py), so a 200 here
# means the same thing while staying independent of web/index.html's title, which
# is free to change without breaking this check.
echo "Testing the built dashboard reached the image..."
if ! curl -sf http://localhost:8000/dashboard-build.json; then
    echo ""
    echo "/dashboard-build.json did not answer, so the gateway found no dashboard bundle"
    echo "and is serving the get-started tutorial at \"/\" instead. Check the web stage in"
    echo "the Dockerfile and the COPY --from=web in the runtime stage."
    echo "=== Gateway logs ==="
    docker logs "$OTARI_CONTAINER"
    exit 1
fi
echo ""

# The image preloads jemalloc in place of glibc malloc. A wrong LD_PRELOAD path
# is only a warning from the loader, so the process boots on glibc either way and
# this has to be read from the running process.
echo "Testing the gateway process runs on jemalloc..."
if ! docker exec "$OTARI_CONTAINER" grep -q libjemalloc /proc/1/maps; then
    echo "libjemalloc is not mapped into the gateway process: check LD_PRELOAD in the Dockerfile"
    docker exec "$OTARI_CONTAINER" sh -c 'echo "LD_PRELOAD=$LD_PRELOAD"; ls -l /usr/local/lib/libjemalloc.so.2'
    exit 1
fi
allocator="$(curl -sf -H "Otari-Key: Bearer test-master-key" "http://localhost:8000/api/v1/debug/memory?limit=1" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["allocator"])')"
echo "The memory diagnostics report allocator: $allocator"
if [[ "$allocator" != "jemalloc" ]]; then
    echo "Expected the memory diagnostics to report jemalloc"
    exit 1
fi

echo "All liveness checks passed!"
