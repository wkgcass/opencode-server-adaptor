#!/usr/bin/env bash
#
# install.sh - Install opencode-server-adaptor
#
# By default, installs only to ~/.local/bin/opencode-server-adaptor.
# Use --link-opencode to also create a compatibility symlink at ~/.opencode/bin/opencode
# (this will overwrite the real OpenCode CLI — use with caution).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configurable paths
PREFIX="${PREFIX:-${HOME}/.local/bin}"
OPENCODE_BIN_DIR="${HOME}/.opencode/bin"
OPENCODE_BIN="${OPENCODE_BIN_DIR}/opencode"

# Flags
FORCE=0
LINK_OPENCODE=0

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

OPTIONS:
  --force           Force overwrite existing opencode binary (backs up first)
  --prefix PATH     Installation prefix for the main binary (default: ~/.local/bin)
  --link-opencode   Also create compatibility symlink at ~/.opencode/bin/opencode
                    (WARNING: this replaces the real OpenCode CLI)
  -h, --help        Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --link-opencode) LINK_OPENCODE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

ADAPTOR_BIN="${PREFIX}/opencode-server-adaptor"

# Step 1: Verify build exists
if [[ ! -f "${PROJECT_DIR}/dist/opencode-server-adaptor" ]]; then
  echo "ERROR: dist/opencode-server-adaptor not found."
  echo "  Build it first with: bun run build"
  exit 1
fi

# Step 2: Install main binary
echo "Installing opencode-server-adaptor to ${ADAPTOR_BIN}"
mkdir -p "${PREFIX}"
cp -f "${PROJECT_DIR}/dist/opencode-server-adaptor" "${ADAPTOR_BIN}"
chmod +x "${ADAPTOR_BIN}"

# Step 3: Optionally create OpenCode compatibility symlink
BACKUP=""
if [[ "${LINK_OPENCODE}" -eq 1 ]]; then
  echo "Creating OpenCode compatibility link at ${OPENCODE_BIN}"
  mkdir -p "${OPENCODE_BIN_DIR}"

  SKIP_LINK=0
  if [[ -e "${OPENCODE_BIN}" || -L "${OPENCODE_BIN}" ]]; then
    if [[ -L "${OPENCODE_BIN}" ]]; then
      LINK_TARGET="$(readlink -f "${OPENCODE_BIN}" 2>/dev/null || true)"
      if [[ "${LINK_TARGET}" == "${ADAPTOR_BIN}" ]]; then
        echo "  ${OPENCODE_BIN} already points to opencode-server-adaptor. Skipping."
        SKIP_LINK=1
      fi
    fi

    if [[ "${SKIP_LINK}" -ne 1 ]]; then
      if [[ "${FORCE}" -ne 1 ]]; then
        echo "ERROR: ${OPENCODE_BIN} already exists."
        echo "  If this is the real OpenCode CLI, installing would replace it."
        echo "  To overwrite (with backup), run: install.sh --link-opencode --force"
        exit 1
      fi

      BACKUP="${OPENCODE_BIN}.backup.$(date +%s)"
      echo "  Backing up existing binary to ${BACKUP}"
      mv "${OPENCODE_BIN}" "${BACKUP}"
    fi
  fi

  if [[ "${SKIP_LINK}" -ne 1 ]]; then
    ln -sf "${ADAPTOR_BIN}" "${OPENCODE_BIN}"
    echo "  Created symlink: ${OPENCODE_BIN} -> ${ADAPTOR_BIN}"
  fi
fi

# Step 4: Verify version
echo ""
echo "Verifying installation..."

VERSION_OUTPUT="$("${ADAPTOR_BIN}" --version 2>/dev/null || true)"
VERSION_FIRST_LINE="$(echo "${VERSION_OUTPUT}" | head -1 | tr -d '[:space:]' || true)"

if [[ -z "${VERSION_FIRST_LINE}" ]]; then
  echo "ERROR: ${ADAPTOR_BIN} --version produced no output"
  exit 1
fi

echo "  ${ADAPTOR_BIN} --version: ${VERSION_FIRST_LINE}"

# Step 5: Verify serve can start (briefly)
echo "  Checking serve startup..."
PORT_OUTPUT="$(bun -e '
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response() } })
  process.stdout.write(String(server.port))
  server.stop(true)
')"

PORT="$(
  printf '%s\n' "${PORT_OUTPUT}" \
    | tr -d '\r' \
    | awk '/^[[:space:]]*[0-9]+[[:space:]]*$/ {
        value = $0
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        port = value
      }
      END { print port }'
)"

if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || (( 10#${PORT} < 1 || 10#${PORT} > 65535 )); then
  echo "ERROR: Could not reserve a valid TCP port for the startup check."
  echo "  Port probe output: ${PORT_OUTPUT@Q}"
  exit 1
fi

env -u OPENCODE_SERVER_PASSWORD -u OPENCODE_SERVER_USERNAME DATABASE_PATH=:memory: \
  "${ADAPTOR_BIN}" --log-level ERROR serve --hostname 127.0.0.1 --port="${PORT}" &
SERVE_PID=$!

HEALTH_OK=0
for i in $(seq 1 25); do
  if ! kill -0 "${SERVE_PID}" 2>/dev/null; then
    break
  fi
  if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 0.2
done

kill "${SERVE_PID}" 2>/dev/null || true
wait "${SERVE_PID}" 2>/dev/null || true

if [[ "${HEALTH_OK}" -ne 1 ]]; then
  echo "ERROR: Health check failed on serve startup"
  exit 1
fi

echo "  Health check: OK"

echo ""
echo "Installation complete!"
echo "  Main binary:   ${ADAPTOR_BIN}"
echo "  Version:       ${VERSION_FIRST_LINE}"
if [[ "${LINK_OPENCODE}" -eq 1 ]]; then
  echo "  OpenCode link: ${OPENCODE_BIN}"
fi
if [[ -n "${BACKUP}" ]]; then
  echo "  Backup:        ${BACKUP}"
  echo "  To restore:    mv ${BACKUP} ${OPENCODE_BIN}"
fi
