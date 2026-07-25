#!/usr/bin/env bash
#
# uninstall.sh - Remove opencode-server-adaptor and restore original OpenCode if backed up
#
set -euo pipefail

PREFIX="${PREFIX:-${HOME}/.local/bin}"
OPENCODE_BIN_DIR="${HOME}/.opencode/bin"
OPENCODE_BIN="${OPENCODE_BIN_DIR}/opencode"
ADAPTOR_BIN="${PREFIX}/opencode-server-adaptor"

usage() {
  cat <<EOF
Usage: uninstall.sh [OPTIONS]

OPTIONS:
  --prefix PATH  Installation prefix (default: ~/.local/bin)
  --purge        Also remove config and state data
  -h, --help     Show this help message
EOF
}

PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

ADAPTOR_BIN="${PREFIX}/opencode-server-adaptor"

# Step 1: Remove the OpenCode compatibility link
echo "Removing OpenCode compatibility link..."
if [[ -L "${OPENCODE_BIN}" ]]; then
  LINK_TARGET="$(readlink -f "${OPENCODE_BIN}" 2>/dev/null || true)"
  if [[ "${LINK_TARGET}" == "${ADAPTOR_BIN}" ]]; then
    rm -f "${OPENCODE_BIN}"
    echo "  Removed: ${OPENCODE_BIN}"
  else
    echo "  ${OPENCODE_BIN} does not point to opencode-server-adaptor. Skipping."
  fi
elif [[ -e "${OPENCODE_BIN}" ]]; then
  echo "  ${OPENCODE_BIN} exists but is not a symlink. Skipping."
else
  echo "  ${OPENCODE_BIN} does not exist. Skipping."
fi

# Step 2: Restore backup if exists
BACKUP_PATTERN="${OPENCODE_BIN}.backup.*"
BACKUPS=()
shopt -s nullglob
for f in ${BACKUP_PATTERN}; do
  BACKUPS+=("$f")
done
shopt -u nullglob

if [[ ${#BACKUPS[@]} -gt 0 ]]; then
  LATEST_BACKUP="${BACKUPS[-1]}"
  echo "Restoring backup: ${LATEST_BACKUP} -> ${OPENCODE_BIN}"
  mv "${LATEST_BACKUP}" "${OPENCODE_BIN}"
  echo "  Restored."
  # Clean up older backups
  for f in "${BACKUPS[@]:0:${#BACKUPS[@]}-1}"; do
    echo "  Removing old backup: ${f}"
    rm -f "$f"
  done
fi

# Step 3: Remove main binary
echo "Removing main binary..."
if [[ -f "${ADAPTOR_BIN}" ]]; then
  rm -f "${ADAPTOR_BIN}"
  echo "  Removed: ${ADAPTOR_BIN}"
else
  echo "  ${ADAPTOR_BIN} not found. Skipping."
fi

# Step 4: Optionally purge data
if [[ "${PURGE}" -eq 1 ]]; then
  echo "Purging config and state data..."
  CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode-server-adaptor"
  STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/opencode-server-adaptor"
  rm -rf "${CONFIG_DIR}"
  rm -rf "${STATE_DIR}"
  echo "  Removed: ${CONFIG_DIR}"
  echo "  Removed: ${STATE_DIR}"
fi

# Step 5: Clean up empty dirs
if [[ -d "${OPENCODE_BIN_DIR}" ]] && [[ -z "$(ls -A "${OPENCODE_BIN_DIR}" 2>/dev/null)" ]]; then
  rmdir "${OPENCODE_BIN_DIR}" 2>/dev/null || true
  echo "  Removed empty directory: ${OPENCODE_BIN_DIR}"
fi

echo ""
echo "Uninstall complete!"
