#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || exit 1
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx.service
