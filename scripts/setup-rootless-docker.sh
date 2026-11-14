#!/usr/bin/env bash
# Explicit operator preparation only. Never invoked by install/upgrade or the web.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run: sudo bash scripts/setup-rootless-docker.sh'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required'; exit 1; }
for tool in /usr/bin/docker /usr/bin/dockerd-rootless-setuptool.sh /usr/bin/newuidmap /usr/bin/newgidmap /usr/bin/rootlesskit /usr/bin/dbus-daemon; do
  [[ -x $tool && $(stat -c %u "$tool") == 0 ]] || {
    echo "Missing root-owned dependency: $tool"
    echo 'Install uidmap, dbus-user-session, slirp4netns and rootless Docker packages using the official Docker Ubuntu repository.'
    echo 'https://docs.docker.com/engine/security/rootless/'
    exit 1
  }
done
getent group ubuntu-projects >/dev/null || { echo 'Install Ubuntu Control first'; exit 1; }
# A regular dedicated account receives subordinate ID ranges through useradd.
if ! getent passwd ubuntu-docker >/dev/null; then
  useradd --create-home --home-dir /var/lib/ubuntu-docker --shell /usr/sbin/nologin ubuntu-docker
fi
[[ $(getent passwd ubuntu-docker | cut -d: -f6) == /var/lib/ubuntu-docker ]] || { echo 'Unexpected ubuntu-docker home; reconcile manually'; exit 1; }
DOCKER_UID=$(id -u ubuntu-docker)
[[ $DOCKER_UID -ne 0 && -d /var/lib/ubuntu-docker && ! -L /var/lib/ubuntu-docker ]] || { echo 'Unsafe dedicated Docker account/home'; exit 1; }
install -d -m 0700 -o ubuntu-docker -g ubuntu-docker /var/lib/ubuntu-docker
usermod -aG ubuntu-projects ubuntu-docker
python3 - <<'PY'
import pathlib,pwd,grp,sys
for filename,allocated in (('/etc/subuid',{p.pw_uid for p in pwd.getpwall()}),('/etc/subgid',{g.gr_gid for g in grp.getgrall()})):
    entries=[]
    for line in pathlib.Path(filename).read_text().splitlines():
        if not line or line.startswith('#'):continue
        name,start,count=line.split(':');entries.append((name,int(start),int(count)))
    dedicated=[entry for entry in entries if entry[0]=='ubuntu-docker']
    if not any(count>=65536 for _,_,count in dedicated):sys.exit('Assign a free range of at least 65536 IDs to ubuntu-docker in '+filename)
    for name,start,count in dedicated:
        end=start+count
        if start<65536 or end>=2**32 or any(start<=value<end for value in allocated):sys.exit('Unsafe subordinate ID range in '+filename)
        if any(other!=name and start<other_start+other_count and other_start<end for other,other_start,other_count in entries):sys.exit('Overlapping subordinate ID ranges in '+filename)
PY
loginctl enable-linger ubuntu-docker
systemctl start "user@$DOCKER_UID.service"
runuser -u ubuntu-docker -- env HOME=/var/lib/ubuntu-docker XDG_RUNTIME_DIR="/run/user/$DOCKER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$DOCKER_UID/bus" /usr/bin/dockerd-rootless-setuptool.sh install --force
runuser -u ubuntu-docker -- env XDG_RUNTIME_DIR="/run/user/$DOCKER_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$DOCKER_UID/bus" systemctl --user enable --now docker.service
runuser -u ubuntu-docker -- env DOCKER_HOST="unix:///run/user/$DOCKER_UID/docker.sock" docker info --format '{{json .SecurityOptions}}'
echo 'Dedicated rootless Docker is ready. Existing Docker services and firewall rules were not changed.'
