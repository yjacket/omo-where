#!/usr/bin/env sh
# Run from a clone: sh install.sh  (local copy only, no download)
set -e
src="$(cd "$(dirname "$0")" && pwd)/extension/omo-where"
agent="${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.omo/agent}}}"
[ -d "$src" ] || { echo "missing $src" >&2; exit 1; }
ext="$agent/extensions"
dst="$ext/omo-where"
tmp="$ext/omo-where.tmp-$$"
mkdir -p "$ext"
rm -rf "$tmp"
cp -R "$src" "$tmp"
rm -rf "$dst"
mv "$tmp" "$dst"
echo "installed -> $dst"
echo "Type /reload in running omo sessions."
