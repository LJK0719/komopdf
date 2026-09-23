#!/usr/bin/env bash
set -euo pipefail

# komopdf production deployment script for cloudcone-komo2
# Strict atomic deployment with automatic rollback upon failure.

BASE_DIR="/opt/pdf-editor"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
PREVIOUS_LINK="${BASE_DIR}/previous"
CONFIG_DIR="/etc/pdf-editor"
CREDENTIAL_DIR="${CONFIG_DIR}/credentials"
CREDENTIAL_FILE="${CREDENTIAL_DIR}/gemini"
SERVICE_NAME="komopdf-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_CONF="/etc/nginx/conf.d/komopdf.conf"

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  echo "Usage: $0 <version-tag>" >&2
  exit 1
fi

TARGET_DIR="${RELEASES_DIR}/${VERSION}"

echo "========================================================"
echo " Starting komopdf deployment: ${VERSION}"
echo "========================================================"

# --- Pre-flight Check 1: Release directory completeness ---
if [ ! -d "${TARGET_DIR}" ]; then
  echo "Error: Release directory not found: ${TARGET_DIR}" >&2
  exit 1
fi

if [ ! -f "${TARGET_DIR}/apps/gateway/dist/cli.mjs" ]; then
  echo "Error: Gateway bundle missing: ${TARGET_DIR}/apps/gateway/dist/cli.mjs" >&2
  exit 1
fi

if [ ! -d "${TARGET_DIR}/apps/gateway/node_modules/fastify" ]; then
  echo "Error: Bundled fastify dependency missing in release: ${TARGET_DIR}/apps/gateway/node_modules/fastify" >&2
  exit 1
fi

if [ ! -f "${TARGET_DIR}/apps/web/dist/index.html" ]; then
  echo "Error: Web application index missing: ${TARGET_DIR}/apps/web/dist/index.html" >&2
  exit 1
fi

# --- Pre-flight Check 2: System User & Directories ---
if ! id -u pdf-editor >/dev/null 2>&1; then
  echo "==> Creating system service user pdf-editor..."
  useradd --system --no-create-home --user-group --shell /usr/sbin/nologin pdf-editor
fi

mkdir -p "${CONFIG_DIR}" "${CREDENTIAL_DIR}" "${RELEASES_DIR}"

# --- Pre-flight Check 3: Strictly Required Credentials ---
if [ ! -f "${CREDENTIAL_FILE}" ]; then
  echo "CRITICAL ERROR: Required credential file does not exist: ${CREDENTIAL_FILE}" >&2
  echo "Please write the upstream Gemini API token to ${CREDENTIAL_FILE} (owner root:root, mode 0400)." >&2
  echo "Refusing to proceed with deployment without valid credentials." >&2
  exit 1
fi

# Ensure strict permissions on credentials
chmod 0400 "${CREDENTIAL_FILE}" 2>/dev/null || true
chown root:root "${CREDENTIAL_FILE}" 2>/dev/null || true

# Install base gateway config if missing
if [ ! -f "${CONFIG_DIR}/gateway.config.json" ]; then
  echo "==> Initializing ${CONFIG_DIR}/gateway.config.json from release template..."
  cp "${TARGET_DIR}/infra/gateway.config.json" "${CONFIG_DIR}/gateway.config.json"
fi

# --- Record Existing Active Target for Rollback ---
OLD_TARGET=""
if [ -L "${CURRENT_LINK}" ]; then
  OLD_TARGET="$(readlink -f "${CURRENT_LINK}" || echo "")"
fi

# Backup existing configs if they exist
SERVICE_BACKUP="/tmp/${SERVICE_NAME}.service.bak.$$"
NGINX_BACKUP="/tmp/komopdf.nginx.conf.bak.$$"
[ -f "${SERVICE_FILE}" ] && cp "${SERVICE_FILE}" "${SERVICE_BACKUP}"
[ -f "${NGINX_CONF}" ] && cp "${NGINX_CONF}" "${NGINX_BACKUP}"

# --- Automatic Rollback Function ---
rollback() {
  local reason="$1"
  echo "" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo " DEPLOYMENT FAILED: ${reason}" >&2
  echo " Executing automatic rollback to previous state..." >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2

  if [ -n "${OLD_TARGET}" ] && [ -d "${OLD_TARGET}" ]; then
    echo "==> Rolling back ${CURRENT_LINK} to ${OLD_TARGET}..."
    local rb_tmp="${BASE_DIR}/current.rollback.$$"
    ln -s "${OLD_TARGET}" "${rb_tmp}"
    mv -Tf "${rb_tmp}" "${CURRENT_LINK}"
  else
    echo "Warning: No previous active release to revert symlink to." >&2
  fi

  if [ -f "${SERVICE_BACKUP}" ]; then
    echo "==> Restoring previous systemd unit..."
    cp "${SERVICE_BACKUP}" "${SERVICE_FILE}"
    systemctl daemon-reload || true
    systemctl restart "${SERVICE_NAME}" || true
  fi

  if [ -f "${NGINX_BACKUP}" ]; then
    echo "==> Restoring previous Nginx configuration..."
    cp "${NGINX_BACKUP}" "${NGINX_CONF}"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi

  rm -f "${SERVICE_BACKUP}" "${NGINX_BACKUP}"
  echo "==> Rollback complete. System returned to pre-deployment state." >&2
  exit 1
}

# --- Step 1: Atomic Symlink Switch ---
echo "==> Performing atomic symlink switch to ${TARGET_DIR}..."
TMP_LINK="${BASE_DIR}/current.tmp.$$"
ln -s "${TARGET_DIR}" "${TMP_LINK}"
if ! mv -Tf "${TMP_LINK}" "${CURRENT_LINK}"; then
  rm -f "${TMP_LINK}"
  rollback "Failed atomic move of current symlink"
fi

# --- Step 2: Update Systemd Unit & Restart Gateway ---
echo "==> Updating systemd unit..."
cp "${TARGET_DIR}/infra/komopdf-gateway.service" "${SERVICE_FILE}"
systemctl daemon-reload

echo "==> Restarting ${SERVICE_NAME}..."
if ! systemctl restart "${SERVICE_NAME}"; then
  rollback "Failed to restart ${SERVICE_NAME} service"
fi

systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true

# --- Step 3: Gateway Health Verification ---
echo "==> Verifying gateway health on http://127.0.0.1:8787/healthz..."
HEALTHY=false
for i in {1..15}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "${HEALTHY}" != "true" ]; then
  journalctl -u "${SERVICE_NAME}" -n 20 --no-pager || true
  rollback "Gateway health check failed on 127.0.0.1:8787/healthz after 15 attempts"
fi

echo "==> Gateway health verified successfully."

# --- Step 4: Update Nginx Configuration & Reload ---
if [ -d /etc/nginx/conf.d ]; then
  echo "==> Installing Nginx site configuration to ${NGINX_CONF}..."
  cp "${TARGET_DIR}/infra/komopdf.nginx.conf" "${NGINX_CONF}"

  echo "==> Testing Nginx configuration syntax..."
  if ! nginx -t; then
    rollback "Nginx configuration syntax test failed (nginx -t)"
  fi

  echo "==> Reloading Nginx..."
  if ! systemctl reload nginx; then
    rollback "Failed to reload Nginx"
  fi
  echo "==> Nginx reloaded successfully."
fi

# --- Step 5: Finalize and Save Previous Link ---
if [ -n "${OLD_TARGET}" ] && [ "${OLD_TARGET}" != "${TARGET_DIR}" ]; then
  ln -sfn "${OLD_TARGET}" "${PREVIOUS_LINK}"
  echo "==> Previous active target recorded at ${PREVIOUS_LINK} -> ${OLD_TARGET}"
fi

# Clean up backups
rm -f "${SERVICE_BACKUP}" "${NGINX_BACKUP}"

echo ""
echo "========================================================"
echo " Deployment of komopdf ${VERSION} SUCCEEDED."
echo " Active link: ${CURRENT_LINK} -> ${TARGET_DIR}"
echo "========================================================"
