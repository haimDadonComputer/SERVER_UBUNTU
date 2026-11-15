#!/usr/bin/env bash
# Upgrade an existing installation. Never runs install.sh, replaces secrets, or
# changes application/project users, firewall rules or project directories.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run: sudo bash scripts/upgrade.sh'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required'; exit 1; }
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$SOURCE_DIR/scripts/install-permissions.sh"
[[ -d /opt/ubuntu-control && ! -L /opt/ubuntu-control && -f /etc/ubuntu-control/app.env && -f /etc/ubuntu-control/helper.json ]] || { echo 'An existing standard installation is required'; exit 1; }
[[ $SOURCE_DIR != /opt/ubuntu-control ]] || { echo 'Run from a separate source checkout, not the live installation'; exit 1; }
for account in ubuntu-control ubuntu-projects; do getent passwd "$account" >/dev/null || { echo "Missing existing user: $account"; exit 1; }; done
for binary in node npm python3 setfacl getfacl openssl curl; do command -v "$binary" >/dev/null || { echo "Missing dependency: $binary"; exit 1; }; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<11))process.exit(1)'
[[ -f /etc/ubuntu-control/github/app.pem && ! -L /etc/ubuntu-control/github/app.pem && $(stat -c %u /etc/ubuntu-control/github/app.pem) == 0 ]] || { echo 'Keep your existing root-owned key at /etc/ubuntu-control/github/app.pem before upgrading'; exit 1; }
# Do not overwrite custom units/drop-ins silently.
for pair in 'ubuntu-control-github.service ubuntu-control-github.service' 'ubuntu-control-helper.service.d/20-github-app.conf github-helper.conf'; do
  read -r target template <<< "$pair"
  if [[ -e /etc/systemd/system/$target ]] && ! cmp -s "/etc/systemd/system/$target" "$SOURCE_DIR/deploy/$template"; then
    echo "Custom unit /etc/systemd/system/$target differs. Review and reconcile it before upgrading."; exit 1
  fi
done
DATA_DIR=$(node --env-file=/etc/ubuntu-control/app.env -p 'require("path").resolve(process.env.DATA_DIR || "/var/lib/ubuntu-control")')
[[ -d $DATA_DIR && -f $DATA_DIR/control.sqlite ]] || { echo 'Existing database not found; nothing changed'; exit 1; }
check_idle() {
  [[ ! -e /var/lib/ubuntu-control-helper/publication/pending.json ]] || { echo 'Publication recovery is pending; inspect the helper before upgrading'; return 1; }
  [[ ! -e /var/lib/ubuntu-control-helper/pending.json ]] || { echo 'Confirm/rollback the pending firewall change before upgrading'; return 1; }
  for transaction in /var/lib/ubuntu-control-helper/runtime-transactions/*.json; do
    [[ ! -f $transaction ]] || { echo 'A project operation or recovery is pending. Inspect the helper and finish recovery before upgrading.'; return 1; }
  done
  python3 - "$DATA_DIR/control.sqlite" <<'PY'
import pathlib,sqlite3,sys
db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
if db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]:
    sys.exit('Active jobs exist. Wait for them to finish before upgrading.')
PY
}
check_idle
STAGE_DIR=$(mktemp -d /opt/.ubuntu-control-upgrade.XXXXXXXX)
for entry in package.json package-lock.json tsconfig.json vite.config.ts playwright.config.ts index.html src server helper deploy scripts tests README.md INSTALL.md VALIDATION.md AGENTS.md TASKS.json; do
  cp -R -- "$SOURCE_DIR/$entry" "$STAGE_DIR/"
done
prepare_install_tree "$STAGE_DIR" ubuntu-control ubuntu-control
cd "$STAGE_DIR"
runuser -u ubuntu-control -- npm ci
runuser -u ubuntu-control -- npm test
runuser -u ubuntu-control -- env PYTHONDONTWRITEBYTECODE=1 npm run check:helper
runuser -u ubuntu-control -- npm run build
runuser -u ubuntu-control -- npm prune --omit=dev --package-lock=false
lock_install_tree "$STAGE_DIR"
chmod 0755 "$STAGE_DIR/helper/github-askpass"
UPGRADE_ID=$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)
BACKUP_DIR=/var/backups/ubuntu-control/$UPGRADE_ID
PREVIOUS_DIR=/opt/.ubuntu-control-previous-$UPGRADE_ID
install -d -m 0700 -o root -g root "$BACKUP_DIR"
WEB_ACTIVE=$(systemctl is-active ubuntu-control.service || true)
HELPER_ACTIVE=$(systemctl is-active ubuntu-control-helper.service || true)
BROKER_ACTIVE=$(systemctl is-active ubuntu-control-github.service || true)
SWAPPED=false
STOPPED=false
UNITS_INSTALLED=false
PUBLICATION_CONFIGURED=false
PUBLICATION_TARGETS=(/etc/nginx/conf.d/ubuntu-control.conf /etc/systemd/system/ubuntu-control-helper.service.d/30-publication.conf /etc/systemd/system/ubuntu-control-cert-renew.service /etc/systemd/system/ubuntu-control-cert-renew.timer /etc/ubuntu-control-publication/prepared)
PUBLICATION_TIMER_ACTIVE=$(systemctl is-active ubuntu-control-cert-renew.timer || true)
PUBLICATION_TIMER_ENABLED=$(systemctl is-enabled ubuntu-control-cert-renew.timer || true)
OLD_MODE=$(stat -c %a /opt/ubuntu-control)
recover() {
  local status=$?
  trap - ERR
  if [[ $SWAPPED == true ]]; then
    systemctl stop ubuntu-control.service ubuntu-control-helper.service || true
    systemctl stop ubuntu-control-github.service || true
    mv -T /opt/ubuntu-control "/opt/.ubuntu-control-failed-$UPGRADE_ID"
    mv -T "$PREVIOUS_DIR" /opt/ubuntu-control
    chmod "$OLD_MODE" /opt/ubuntu-control
  elif [[ -d $PREVIOUS_DIR && ! -e /opt/ubuntu-control ]]; then
    mv -T "$PREVIOUS_DIR" /opt/ubuntu-control
    chmod "$OLD_MODE" /opt/ubuntu-control
  fi
  if [[ $UNITS_INSTALLED == true ]]; then
    if [[ -f $BACKUP_DIR/github.service ]]; then
      install -m 0644 "$BACKUP_DIR/github.service" /etc/systemd/system/ubuntu-control-github.service
    else
      systemctl disable ubuntu-control-github.service || true
      rm -f -- /etc/systemd/system/ubuntu-control-github.service
    fi
    if [[ -f $BACKUP_DIR/github-helper.conf ]]; then
      install -m 0644 "$BACKUP_DIR/github-helper.conf" /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf
    else
      rm -f -- /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf
    fi
    systemctl daemon-reload
  fi
  if [[ $PUBLICATION_CONFIGURED == true ]]; then
    systemctl stop ubuntu-control-cert-renew.timer || true
    if [[ $PUBLICATION_TIMER_ENABLED != enabled && $PUBLICATION_TIMER_ENABLED != enabled-runtime ]]; then
      systemctl disable ubuntu-control-cert-renew.timer || true
    fi
    for target in "${PUBLICATION_TARGETS[@]}"; do
      saved="$BACKUP_DIR/publication-config/${target##*/}"
      if [[ -f $saved ]]; then cp -a -- "$saved" "$target"; else rm -f -- "$target"; fi
    done
    systemctl daemon-reload
    if [[ $PUBLICATION_TIMER_ENABLED == enabled ]]; then
      systemctl enable ubuntu-control-cert-renew.timer || true
    elif [[ $PUBLICATION_TIMER_ENABLED == enabled-runtime ]]; then
      systemctl enable --runtime ubuntu-control-cert-renew.timer || true
    fi
    [[ $PUBLICATION_TIMER_ACTIVE != active ]] || systemctl start ubuntu-control-cert-renew.timer || true
    /usr/sbin/nginx -t && systemctl reload nginx.service || true
  fi
  if [[ $STOPPED == true ]]; then
    [[ $BROKER_ACTIVE != active ]] || systemctl start ubuntu-control-github.service || true
    [[ $HELPER_ACTIVE != active ]] || systemctl start ubuntu-control-helper.service || true
    [[ $WEB_ACTIVE != active ]] || systemctl start ubuntu-control.service || true
  fi
  echo "Upgrade failed; previous code restored when necessary. Backups: $BACKUP_DIR"
  echo 'Database/configuration were not replaced. Additive schema columns remain compatible with the previous version.'
  exit "$status"
}
trap recover ERR
# Package installation happens while the existing management application is live.
bash "$STAGE_DIR/scripts/setup-publication.sh" --dependencies-only
# Short maintenance window begins only after the new immutable tree passes checks.
check_idle
STOPPED=true
systemctl stop ubuntu-control.service ubuntu-control-helper.service
if [[ $BROKER_ACTIVE == active ]]; then systemctl stop ubuntu-control-github.service; fi
check_idle
cp -a /etc/ubuntu-control "$BACKUP_DIR/etc-ubuntu-control"
cp -a /var/lib/ubuntu-control-helper "$BACKUP_DIR/helper-state"
install -d -m 0700 "$BACKUP_DIR/publication-config"
for target in "${PUBLICATION_TARGETS[@]}"; do
  [[ ! -L $target ]] || { echo "Unsafe publication configuration: $target"; false; }
  [[ ! -f $target ]] || cp -a -- "$target" "$BACKUP_DIR/publication-config/${target##*/}"
done
if [[ -d /etc/ubuntu-control-publication ]]; then cp -a /etc/ubuntu-control-publication "$BACKUP_DIR/publication-secrets"; fi
if [[ -d /etc/nginx/ubuntu-control ]]; then cp -a /etc/nginx/ubuntu-control "$BACKUP_DIR/publication-proxy"; fi
# Runtime units are regenerated from the root registry. Preserve their current
# definitions for diagnosis; never convert/start/stop individual projects here.
install -d -m 0700 "$BACKUP_DIR/managed-units"
for unit in /run/systemd/system/uc-project-*.service; do
  [[ ! -f $unit || -L $unit ]] || cp -a -- "$unit" "$BACKUP_DIR/managed-units/"
done
install -d -m 0700 -o root -g root /etc/ubuntu-control/projects
install -d -m 0755 -o root -g root /var/lib/ubuntu-control-projects
for storage_root in /var/lib/ubuntu-control-code /var/lib/ubuntu-control-storage; do
  [[ ! -L $storage_root ]] || { echo "Unsafe storage root: $storage_root"; false; }
  install -d -m 0755 -o root -g root "$storage_root"
done
if [[ -d /var/lib/ubuntu-control-github ]]; then cp -a /var/lib/ubuntu-control-github "$BACKUP_DIR/github-state"; fi
python3 - "$DATA_DIR/control.sqlite" "$BACKUP_DIR/control.sqlite" <<'PY'
import pathlib,sqlite3,sys
source=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
target=sqlite3.connect(sys.argv[2]);source.backup(target);target.close();source.close()
PY
printf '%s\n' "$PREVIOUS_DIR" > "$BACKUP_DIR/previous-code-path"
if [[ -f /etc/systemd/system/ubuntu-control-github.service ]]; then cp -a /etc/systemd/system/ubuntu-control-github.service "$BACKUP_DIR/github.service"; fi
if [[ -f /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf ]]; then cp -a /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf "$BACKUP_DIR/github-helper.conf"; fi
bash "$STAGE_DIR/scripts/github-access.sh"
UNITS_INSTALLED=true
install -d -m 0755 /etc/systemd/system/ubuntu-control-helper.service.d
install -m 0644 "$STAGE_DIR/deploy/ubuntu-control-github.service" /etc/systemd/system/ubuntu-control-github.service
install -m 0644 "$STAGE_DIR/deploy/github-helper.conf" /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf
mv -T /opt/ubuntu-control "$PREVIOUS_DIR"
mv -T "$STAGE_DIR" /opt/ubuntu-control
SWAPPED=true
chmod 0700 "$PREVIOUS_DIR"
PUBLICATION_CONFIGURED=true
bash /opt/ubuntu-control/scripts/setup-publication.sh --configure-only
systemctl daemon-reload
systemctl enable ubuntu-control-github.service
systemctl start ubuntu-control-github.service ubuntu-control-helper.service ubuntu-control.service
for i in {1..20}; do
  if systemctl is-active --quiet ubuntu-control-github.service ubuntu-control-helper.service ubuntu-control.service && curl --silent --fail http://127.0.0.1:3080/api/health >/dev/null; then
    trap - ERR
    echo "Upgrade complete. Root-only backups: $BACKUP_DIR"
    echo 'Existing users, GitHub settings, projects and update policies were preserved.'
    echo 'HTTPS dependencies and renewal are ready. Use the publication buttons; no separate preparation command or manual TLS key is required.'
    echo 'Review Project > Runtime settings. Existing projects remain manual and unconverted.'
    echo 'Upload/data mappings are applied on the next explicit project start/deploy. Running projects and their files are not changed by this upgrade.'
    echo 'Validate Node/Docker deployment and rollback on a test project before enabling automatic updates.'
    exit 0
  fi
  sleep 1
done
false # Trigger recovery if the services/HTTP health check did not succeed.
