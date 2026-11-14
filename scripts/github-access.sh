#!/usr/bin/env bash
# Root-only setup for the dedicated broker. Never reads or replaces PEM content.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run this script with sudo'; exit 1; }
getent passwd ubuntu-github >/dev/null || useradd --system --user-group --create-home --home-dir /var/lib/ubuntu-control-github --shell /usr/sbin/nologin ubuntu-github
[[ $(id -u ubuntu-github) -ne 0 ]] || { echo 'Invalid broker identity'; exit 1; }
install -d -m 0700 -o ubuntu-github -g ubuntu-github /var/lib/ubuntu-control-github
if [[ ! -e /etc/ubuntu-control/github ]]; then
  install -d -m 0700 -o root -g root /etc/ubuntu-control/github
fi
[[ ! -L /etc/ubuntu-control && ! -L /etc/ubuntu-control/github && $(stat -c %u /etc/ubuntu-control/github) == 0 ]] || { echo 'GitHub configuration directory must be root-owned and not a symlink'; exit 1; }
setfacl -m u:ubuntu-github:--x /etc/ubuntu-control
setfacl -m u:ubuntu-github:r-x /etc/ubuntu-control/github
if [[ -e /etc/ubuntu-control/github/app.pem || -L /etc/ubuntu-control/github/app.pem ]]; then
  [[ -f /etc/ubuntu-control/github/app.pem && ! -L /etc/ubuntu-control/github/app.pem && $(stat -c %u /etc/ubuntu-control/github/app.pem) == 0 ]] || { echo 'Existing app.pem must be a root-owned regular file'; exit 1; }
  # Remove previous named grants before granting precisely this service read access.
  setfacl -b /etc/ubuntu-control/github/app.pem
  chmod 0600 /etc/ubuntu-control/github/app.pem
  setfacl -m u:ubuntu-github:r-- /etc/ubuntu-control/github/app.pem
fi
