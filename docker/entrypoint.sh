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

# Provider credentials: any recognized source silences the warning. Pi reads
# per-provider env vars natively (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...); the
# PI_OPENAI_* family synthesizes an OpenAI-compatible endpoint at boot
# (src/openai-compat.ts). A key-less PI_OPENAI_BASE_URL is valid (Ollama-style
# endpoints ignore auth).
if [ -z "${DEEPSEEK_API_KEY}" ] && [ -z "${OPENAI_API_KEY}" ] && [ -z "${PI_OPENAI_API_KEY}" ] && [ -z "${PI_OPENAI_BASE_URL}" ]; then
    echo "pi-api-facade: WARNING — no provider credential found (DEEPSEEK_API_KEY / OPENAI_API_KEY / PI_OPENAI_*);" >&2
    echo "  model turns will fail at runtime until the selected provider has a credential." >&2
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
