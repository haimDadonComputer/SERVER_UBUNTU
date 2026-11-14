#!/usr/bin/env bash
# Sourced by the installer and its Linux regression test. Never touches /etc or
# runtime data: callers pass the newly created application directory only.

prepare_install_tree() {
  local install_dir=$1 build_user=$2 build_group=$3
  # cp under umask 077 can leave source at 0600 and directories at 0700.
  # Establish explicit read/traverse access without granting source writes or
  # retaining executable/set-ID bits from the uploaded source tree.
  chown -R root:root -- "$install_dir"
  find "$install_dir" -type d -exec chmod 0755 -- {} +
  find "$install_dir" -type f -exec chmod 0644 -- {} +
  # The parent stays root-owned, so build code cannot replace source directories.
  install -d -m 0755 -o "$build_user" -g "$build_group" -- \
    "$install_dir/node_modules" "$install_dir/dist"
}

lock_install_tree() {
  local install_dir=$1
  chown -R root:root -- "$install_dir"
  # npm inherits umask 077 too. Keep dependency executables executable and make
  # all runtime modules/assets readable, then remove every non-root write bit.
  chmod -R a+rX,go-w -- "$install_dir"
}
