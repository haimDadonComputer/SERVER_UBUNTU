#!/usr/bin/env bash
# Real Linux permission/UID regression test; no system services or users changed.
set -Eeuo pipefail
umask 077
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || { echo 'Run this test as root on Linux'; exit 1; }
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$SOURCE_DIR/scripts/install-permissions.sh"
TEST_USER=nobody
TEST_GROUP=$(id -gn "$TEST_USER")
TEST_DIR=$(mktemp -d /tmp/ubuntu-control-permissions.XXXXXXXX)
trap 'rm -rf -- "$TEST_DIR"' EXIT
chmod 0755 "$TEST_DIR"
APP_DIR=$TEST_DIR/app
mkdir -p "$APP_DIR/src/nested" "$APP_DIR/helper" "$APP_DIR/deploy"
printf 'readable source\n' > "$APP_DIR/src/nested/source.txt"
printf 'privileged helper\n' > "$APP_DIR/helper/helper.py"
printf 'privileged service template\n' > "$APP_DIR/deploy/control.service"
# Stand-in for secrets/runtime data outside the application tree.
printf 'private\n' > "$TEST_DIR/private.env"
cat > "$APP_DIR/package.json" <<'EOF'
{"name":"install-permission-fixture","version":"1.0.0","private":true,"scripts":{"postinstall":"node check-install.cjs"}}
EOF
cat > "$APP_DIR/package-lock.json" <<'EOF'
{"name":"install-permission-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"install-permission-fixture","version":"1.0.0","hasInstallScript":true}}}
EOF
cat > "$APP_DIR/check-install.cjs" <<'EOF'
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.notEqual(process.getuid(), 0);
for (const name of ['package.json', 'package-lock.json', 'src/nested/source.txt', 'helper/helper.py', 'deploy/control.service']) {
  fs.readFileSync(name);
  assert.throws(() => fs.openSync(name, 'a'), { code: 'EACCES' });
}
for (const name of ['new-source.txt', 'src/new-source.txt', 'helper/new-helper.py', 'deploy/new.service']) {
  assert.throws(() => fs.writeFileSync(name, 'forbidden'), { code: 'EACCES' });
}
assert.throws(() => fs.renameSync('src', 'src-replaced'), { code: 'EACCES' });
// Simulate dependency files and generated assets created under umask 077.
fs.mkdirSync('node_modules/example/bin', {recursive:true, mode:0o700});
fs.writeFileSync('node_modules/example/module.cjs', 'module.exports=42;\n', {mode:0o600});
fs.writeFileSync('node_modules/example/bin/tool', '#!/bin/sh\necho tool-ok\n', {mode:0o700});
fs.mkdirSync('node_modules/.bin', {recursive:true});
fs.rmSync('node_modules/.bin/example', {force:true});
fs.symlinkSync('../example/bin/tool', 'node_modules/.bin/example');
fs.writeFileSync('dist/index.html', 'built', {mode:0o600});
EOF
chmod 0777 "$APP_DIR/helper/helper.py" # Uploaded executable/write bits must not survive.
prepare_install_tree "$APP_DIR" "$TEST_USER" "$TEST_GROUP"
[[ $(stat -c '%U:%G:%a' "$APP_DIR/helper/helper.py") == root:root:644 ]]
[[ $(stat -c '%U:%G:%a' "$APP_DIR/src/nested") == root:root:755 ]]
install -d -m 0700 -o "$TEST_USER" -g "$TEST_GROUP" "$TEST_DIR/home" "$TEST_DIR/cache"
cd "$APP_DIR"
# Real npm ci, with no dependencies or network access needed by the fixture.
runuser -u "$TEST_USER" -- env HOME="$TEST_DIR/home" npm ci --offline --no-audit --no-fund --cache "$TEST_DIR/cache"
runuser -u "$TEST_USER" -- env HOME="$TEST_DIR/home" npm prune --omit=dev --package-lock=false --offline --no-audit --no-fund --cache "$TEST_DIR/cache"
# npm prune can remove extraneous fixtures; recreate them using the same lifecycle check.
runuser -u "$TEST_USER" -- node check-install.cjs
lock_install_tree "$APP_DIR"
for entry in src/nested/source.txt helper/helper.py deploy/control.service node_modules dist; do
  runuser -u "$TEST_USER" -- test -r "$APP_DIR/$entry"
  if runuser -u "$TEST_USER" -- test -w "$APP_DIR/$entry"; then
    echo "FAIL: $entry remains writable after locking"; exit 1
  fi
done
runuser -u "$TEST_USER" -- node -e "if(require('./node_modules/example/module.cjs')!==42)process.exit(1)"
[[ $(runuser -u "$TEST_USER" -- ./node_modules/.bin/example) == tool-ok ]]
[[ $(stat -c '%U:%G:%a' "$TEST_DIR/private.env") == root:root:600 ]]
if runuser -u "$TEST_USER" -- test -r "$TEST_DIR/private.env"; then
  echo 'FAIL: private file outside the application became readable'; exit 1
fi
echo 'PASS: npm ci/prune as non-root; readable immutable source; writable build outputs only; locked readable runtime and executable bins; private files unchanged'
