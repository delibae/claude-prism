#!/usr/bin/env bash
# Install a ClaudePrism .deb and check that the app starts and stays up under
# Xvfb with Mesa (software GL). Guards against the startup crashes in #204
# (heap corruption in gtk_init) and #213 (segfault in Mesa's driconf/expat
# when WebKitGTK creates a GL context).
#
# Usage: linux-smoke-test.sh <path-to.deb> [seconds-to-stay-up]
# Exit 0 if the app was still running after the timeout, 1 otherwise.
set -uo pipefail

DEB="$(realpath "$1")"
SECONDS_UP="${2:-20}"

sudo apt-get install -y --allow-downgrades "$DEB" >/dev/null

WORK_HOME="$(mktemp -d)"
LOG="$(mktemp)"

# Fresh HOME so no previous state affects startup. Don't set any WEBKIT_*
# workaround variables: we want the default GL path that crashed.
HOME="$WORK_HOME" dbus-run-session -- \
  xvfb-run -a -s "-screen 0 1280x800x24" \
  timeout -s TERM "$SECONDS_UP" /usr/bin/claude-prism-desktop >"$LOG" 2>&1
code=$?

echo "--- app output (tail) ---"
tail -n 40 "$LOG"
echo "-------------------------"

if [ "$code" -eq 124 ]; then
  echo "PASS: app stayed up for ${SECONDS_UP}s"
  exit 0
fi

case "$code" in
  134) why="SIGABRT (e.g. free(): invalid pointer)" ;;
  139) why="SIGSEGV" ;;
  0) why="exited on its own" ;;
  *) why="exit code $code" ;;
esac
echo "FAIL: app did not stay up: $why"
exit 1
