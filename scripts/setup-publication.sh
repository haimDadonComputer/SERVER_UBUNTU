#!/usr/bin/env bash
# Upgrade preparation (also callable directly). Never publishes sites or opens firewall rules.
set -Eeuo pipefail
umask 077
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODE=${1:-full}
[[ $MODE == full || $MODE == --dependencies-only || $MODE == --configure-only ]] || { echo 'Invalid preparation mode'; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required'; exit 1; }
[[ -f /etc/ubuntu-control/helper.json && -d /opt/ubuntu-control ]] || { echo 'Upgrade Ubuntu Control first'; exit 1; }
# Preparation installs an empty managed proxy, not a public listener. The fresh
# package is masked until its default site is removed. Check address-specific
# conflicts at publication time, when the actual public IP is known; Tailscale
# may already own :443 on its separate interfaces and must remain untouched.
fresh=false
command -v nginx >/dev/null || fresh=true
for path in /etc/nginx/ubuntu-control /etc/ubuntu-control-publication /opt/ubuntu-control-acme /var/lib/ubuntu-control-acme; do
  [[ ! -L $path ]] || { echo "Unsafe symlink: $path"; exit 1; }
done
if [[ $MODE != --configure-only ]]; then
deps_ready=false
if command -v nginx >/dev/null && [[ -x /opt/ubuntu-control-acme/bin/certbot ]]; then
  if /opt/ubuntu-control-acme/bin/certbot --version | python3 -c 'import re,sys; m=re.search(r"(\d+)\.(\d+)",sys.stdin.read()); sys.exit(0 if m and tuple(map(int,m.groups()))>=(5,4) else 1)'; then deps_ready=true; fi
fi
if [[ $deps_ready == false ]]; then
if [[ $fresh == true && -e /etc/nginx/nginx.conf ]]; then
  echo 'Existing Nginx configuration was found without its binary. Restore the existing package before automatic preparation; configuration was not changed.'; exit 1
fi
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
fi
fi
if [[ $MODE == --dependencies-only ]]; then echo 'HTTPS dependencies ready; no sites published or management service restarted.'; exit 0; fi
[[ -x /usr/sbin/nginx && -x /opt/ubuntu-control-acme/bin/certbot ]] || { echo 'HTTPS dependencies are missing'; exit 1; }
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
    # Accept only the exact former managed publication drop-in. Arbitrary
    # operator overrides still require review, and upgrade.sh backs this up.
    if [[ $template == publication-helper.conf && $(cat "$destination") == $'[Service]\nReadWritePaths=/etc/nginx/ubuntu-control /etc/ubuntu-control-publication' ]]; then
      install -m 0600 "$destination" /etc/ubuntu-control-publication/previous-publication-helper.conf
    else
      echo "Custom unit differs: $destination. Reconcile it manually."; exit 1
    fi
  fi
  install -m 0644 "$SOURCE_DIR/deploy/$template" "$destination"
done
touch /etc/ubuntu-control-publication/prepared
systemctl daemon-reload
systemctl enable --now ubuntu-control-cert-renew.timer
if [[ $MODE == full ]]; then systemctl restart ubuntu-control-helper.service; fi
echo 'Prepared. Configure public IP, management domain and certificate email in Settings.'
echo 'Existing proxy sites remain unchanged. Resolve any existing port-80 listener before first publication.'
echo 'If UFW is active, verify host networking before setting ufw_verified_host_network in helper.json.'
echo 'Contabo network firewall rules must be configured separately. No application was published.'
