#!/bin/sh
# pi-api-facade container entrypoint: boot-time honesty checks + headless
# project-trust seeding, then hand over to node (exec, so signals reach it).
set -e

# Fail closed: without northbound keys the facade rejects every authenticated
# call — better to say so at boot than to run a dead endpoint.
if [ -z "${PI_FACADE_API_KEYS}" ]; then
    echo "pi-api-facade: PI_FACADE_API_KEYS is empty — refusing to boot (fail closed)." >&2
    echo "  Generate a key (openssl rand -hex 16) and set it in .env" >&2
    exit 1
fi

if [ -z "${DEEPSEEK_API_KEY}" ]; then
    echo "pi-api-facade: WARNING — DEEPSEEK_API_KEY is not set; deepseek sessions will fail at runtime." >&2
fi

# Headless project trust: Pi cannot prompt in a container, and without a saved
# decision it silently skips workspace .pi resources (SYSTEM.md, skills,
# extensions). Seed the node-level default once; never overwrite an existing
# settings file (the operator may have customized it).
AGENT_DIR="${PI_AGENT_DIR:-/data/agent}"
mkdir -p "${AGENT_DIR}"
SETTINGS="${AGENT_DIR}/settings.json"
if [ ! -f "${SETTINGS}" ]; then
    echo '{ "defaultProjectTrust": "always" }' > "${SETTINGS}"
    echo "pi-api-facade: seeded ${SETTINGS} (defaultProjectTrust: always)"
fi

exec node /opt/pi-api-facade/src/index.ts
