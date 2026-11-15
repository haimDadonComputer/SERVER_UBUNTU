#!/usr/bin/env bash
# Explicit preparation only. Does not publish applications or open firewall rules.
set -Eeuo pipefail
umask 077
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required'; exit 1; }
[[ -f /etc/ubuntu-control/helper.json && -d /opt/ubuntu-control ]] || { echo 'Upgrade Ubuntu Control first'; exit 1; }
# Refuse existing listeners that cannot belong to an installed Nginx service.
fresh=false
command -v nginx >/dev/null || fresh=true
if ! command -v nginx >/dev/null && ss -H -lnt '( sport = :80 or sport = :443 )' | read -r _; then
  echo 'Ports 80/443 are occupied. Resolve the existing proxy before preparation.'; exit 1
fi
for path in /etc/nginx/ubuntu-control /etc/ubuntu-control-publication /opt/ubuntu-control-acme /var/lib/ubuntu-control-acme; do
  [[ ! -L $path ]] || { echo "Unsafe symlink: $path"; exit 1; }
done
apt-get update
if [[ $fresh == true ]]; then
  [[ ! -e /run/systemd/system/nginx.service && ! -L /run/systemd/system/nginx.service ]] || { echo 'Nginx already has a runtime override'; exit 1; }
  systemctl mask --runtime nginx.service
  trap 'systemctl unmask --runtime nginx.service' EXIT
fi
apt-get install -y nginx python3-venv
if [[ $fresh == true ]]; then
  if [[ -L /etc/nginx/sites-enabled/default && $(readlink -f /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]]; then
    unlink /etc/nginx/sites-enabled/default
  fi
  systemctl unmask --runtime nginx.service
  trap - EXIT
  systemctl enable --now nginx.service
fi
python3 -m venv /opt/ubuntu-control-acme
/opt/ubuntu-control-acme/bin/pip install 'certbot>=5.4,<6'
install -d -o root -g root -m 0755 /etc/nginx/ubuntu-control /var/lib/ubuntu-control-acme
install -d -o root -g root -m 0700 /etc/ubuntu-control-publication
include=/etc/nginx/conf.d/ubuntu-control.conf
expected='include /etc/nginx/ubuntu-control/*.conf;'
[[ ! -L $include ]] || { echo 'Unsafe Nginx include'; exit 1; }
if [[ -e $include ]] && [[ $(cat "$include") != "$expected" ]]; then
  echo 'Existing ubuntu-control.conf differs; resolve it manually.'; exit 1
fi
printf '%s\n' "$expected" > "$include"
chmod 0644 "$include"
nginx -t
install -d -m 0755 /etc/systemd/system/ubuntu-control-helper.service.d
for pair in 'publication-helper.conf ubuntu-control-helper.service.d/30-publication.conf' 'ubuntu-control-cert-renew.service ubuntu-control-cert-renew.service' 'ubuntu-control-cert-renew.timer ubuntu-control-cert-renew.timer'; do
  read -r template target <<< "$pair"
  destination=/etc/systemd/system/$target
  [[ ! -L $destination ]] || { echo "Unsafe unit symlink: $destination"; exit 1; }
  if [[ -e $destination ]] && ! cmp -s "$SOURCE_DIR/deploy/$template" "$destination"; then
    echo "Custom unit differs: $destination. Reconcile it manually."; exit 1
  fi
  install -m 0644 "$SOURCE_DIR/deploy/$template" "$destination"
done
touch /etc/ubuntu-control-publication/prepared
systemctl daemon-reload
systemctl enable --now ubuntu-control-cert-renew.timer
systemctl restart ubuntu-control-helper.service
echo 'Prepared. Configure public IP, management domain and certificate email in Settings.'
echo 'Existing proxy sites remain unchanged. Resolve any existing port-80 listener before first publication.'
echo 'If UFW is active, verify host networking before setting ufw_verified_host_network in helper.json.'
echo 'Contabo network firewall rules must be configured separately. No application was published.'
