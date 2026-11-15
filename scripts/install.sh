#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run using sudo bash scripts/install.sh'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 LTS is required'; exit 1; }
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$SOURCE_DIR/scripts/install-permissions.sh"
for target in /opt/ubuntu-control /etc/ubuntu-control /etc/systemd/system/ubuntu-control.service /etc/systemd/system/ubuntu-control-helper.service; do
  [[ ! -e $target && ! -L $target ]] || { echo "Refusing to overwrite $target. See INSTALL.md for upgrades."; exit 1; }
done
read -r -p 'HTTPS origin reachable through your VPN (e.g. https://control.example.com): ' PUBLIC_ORIGIN
[[ $PUBLIC_ORIGIN =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo 'Invalid HTTPS origin'; exit 1; }
command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<11))process.exit(1)' || { echo 'Install Node.js 24.11+ LTS from nodejs.org first, then rerun this script. No remote script will be executed as root.'; exit 1; }
command -v npm >/dev/null || { echo 'npm is required'; exit 1; }
[[ -f $SOURCE_DIR/package-lock.json ]] || { echo 'package-lock.json is missing'; exit 1; }
apt-get update
apt-get install -y python3 git ufw iproute2 ca-certificates curl openssl acl build-essential
getent passwd ubuntu-control >/dev/null || useradd --system --user-group --create-home --home-dir /var/lib/ubuntu-control --shell /usr/sbin/nologin ubuntu-control
getent passwd ubuntu-projects >/dev/null || useradd --system --user-group --create-home --home-dir /var/lib/ubuntu-projects --shell /usr/sbin/nologin ubuntu-projects
usermod -aG ubuntu-projects ubuntu-control
install -d -m 0700 -o ubuntu-control -g ubuntu-control /var/lib/ubuntu-control
install -d -m 0700 -o root -g root /var/lib/ubuntu-control-helper
install -d -m 0750 -o root -g ubuntu-control /etc/ubuntu-control
install -d -m 0700 -o root -g root /etc/ubuntu-control/projects
install -d -m 0755 -o root -g root /var/lib/ubuntu-control-projects
install -d -m 0750 -o root -g ubuntu-projects /srv/ubuntu-projects
install -d -m 0755 -o root -g root /opt/ubuntu-control
# Copy only known source paths; never copy .env, data, Git credentials or node_modules.
for entry in package.json package-lock.json tsconfig.json vite.config.ts playwright.config.ts index.html src server helper deploy scripts tests integrations README.md INSTALL.md VALIDATION.md AGENTS.md TASKS.json; do
  cp -R -- "$SOURCE_DIR/$entry" /opt/ubuntu-control/
done
# Build dependencies can write only their own modules and build output, never the
# helper, installer, service units or source that will later run with privileges.
prepare_install_tree /opt/ubuntu-control ubuntu-control ubuntu-control
cd /opt/ubuntu-control
# Dependency lifecycle scripts and build tools never execute as root.
runuser -u ubuntu-control -- npm ci
runuser -u ubuntu-control -- npm test
runuser -u ubuntu-control -- npm run build
runuser -u ubuntu-control -- npm prune --omit=dev --package-lock=false
lock_install_tree /opt/ubuntu-control
chmod 0755 /opt/ubuntu-control/helper/github-askpass
install -m 0600 deploy/helper.example.json /etc/ubuntu-control/helper.json
MASTER_KEY=$(openssl rand -hex 32)
cat > /etc/ubuntu-control/app.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3080
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
DATA_DIR=/var/lib/ubuntu-control
HELPER_SOCKET=/run/ubuntu-control/helper.sock
PROJECT_ROOT=/srv/ubuntu-projects
MASTER_KEY=$MASTER_KEY
LOCAL_DEV=false
EOF
unset MASTER_KEY
chown root:ubuntu-control /etc/ubuntu-control/app.env
chmod 0640 /etc/ubuntu-control/app.env
NODE_BINARY=$(command -v node)
[[ $NODE_BINARY == /usr/bin/node || $NODE_BINARY == /usr/local/bin/node ]] || { echo 'Node must be installed system-wide under /usr/bin or /usr/local/bin'; exit 1; }
sed "s|/usr/bin/node|$NODE_BINARY|g" deploy/ubuntu-control.service > /etc/systemd/system/ubuntu-control.service
install -m 0644 deploy/ubuntu-control-helper.service /etc/systemd/system/ubuntu-control-helper.service
bash scripts/github-access.sh
install -m 0644 deploy/ubuntu-control-github.service /etc/systemd/system/ubuntu-control-github.service
install -d -m 0755 /etc/systemd/system/ubuntu-control-helper.service.d
install -m 0644 deploy/github-helper.conf /etc/systemd/system/ubuntu-control-helper.service.d/20-github-app.conf
echo 'Create the initial administrator. The password is not echoed.'
runuser -u ubuntu-control -- "$NODE_BINARY" --env-file=/etc/ubuntu-control/app.env server/admin.mjs
systemctl daemon-reload
systemctl enable --now ubuntu-control-github.service ubuntu-control-helper.service ubuntu-control.service
for i in {1..20}; do
  if curl --silent --fail http://127.0.0.1:3080/api/health >/dev/null; then
    echo 'Installed. Listening only on 127.0.0.1:3080. No firewall or public access was changed.'
    echo 'Next: configure your VPN HTTPS reverse proxy and authorize projects using INSTALL.md.'
    exit 0
  fi
  sleep 1
done
echo 'Health check failed. Inspect: sudo journalctl -u ubuntu-control -n 50'
exit 1
