#!/usr/bin/env bash
set -euo pipefail

# komopdf rollback execution script for cloudcone-komo2

BASE_DIR="/opt/pdf-editor"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
PREVIOUS_LINK="${BASE_DIR}/previous"
SERVICE_NAME="komopdf-gateway"

TARGET_VERSION="${1:-}"

if [ -n "${TARGET_VERSION}" ]; then
  TARGET_DIR="${RELEASES_DIR}/${TARGET_VERSION}"
elif [ -L "${PREVIOUS_LINK}" ] && [ -d "$(readlink -f "${PREVIOUS_LINK}")" ]; then
  TARGET_DIR="$(readlink -f "${PREVIOUS_LINK}")"
else
  # Fallback: find second latest release directory
  CURRENT_REAL="$(readlink -f "${CURRENT_LINK}" 2>/dev/null || echo "")"
  DETECTED="$(ls -dt "${RELEASES_DIR}"/* 2>/dev/null | grep -v -x "${CURRENT_REAL}" | head -n 1 || echo "")"
  if [ -n "${DETECTED}" ] && [ -d "${DETECTED}" ]; then
    TARGET_DIR="${DETECTED}"
  else
    echo "Error: No valid previous release found to rollback to." >&2
    exit 1
  fi
fi

if [ ! -d "${TARGET_DIR}" ]; then
  echo "Error: Target rollback directory does not exist: ${TARGET_DIR}" >&2
  exit 1
fi

echo "==> Rolling back komopdf to: ${TARGET_DIR}"

OLD_ACTIVE="$(readlink -f "${CURRENT_LINK}" 2>/dev/null || echo "")"

# 1. Atomic symlink switch
TMP_LINK="${BASE_DIR}/current.rollback.tmp.$$"
ln -s "${TARGET_DIR}" "${TMP_LINK}"
mv -Tf "${TMP_LINK}" "${CURRENT_LINK}"

# 2. Restart service
echo "==> Restarting ${SERVICE_NAME}..."
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"

# 3. Health verification
echo "==> Verifying gateway health..."
HEALTHY=false
for i in {1..10}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "${HEALTHY}" != "true" ]; then
  echo "WARNING: Gateway health check failed after rollback! Inspect journalctl -u ${SERVICE_NAME}" >&2
  exit 1
fi

# 4. Reload Nginx
if nginx -t >/dev/null 2>&1; then
  echo "==> Reloading Nginx..."
  systemctl reload nginx
fi

# 5. Update previous link to point to what was active before this rollback
if [ -n "${OLD_ACTIVE}" ] && [ "${OLD_ACTIVE}" != "${TARGET_DIR}" ]; then
  ln -sfn "${OLD_ACTIVE}" "${PREVIOUS_LINK}"
fi

echo "==> Rollback successfully completed. Active release is now: $(basename "${TARGET_DIR}")"
