#!/bin/bash
# Launch Codex App Server with no view of Hermes, Caller, or the operator's home.
# The parent Python bridge supplies short-lived ChatGPT auth tokens over stdio.
set -euo pipefail

# Re-exec through root-owned binaries with only the launcher configuration.
# In particular, drop Worker bearer/HMAC secrets before running readlink or
# bubblewrap. The App Server receives ChatGPT auth solely through stdio.
if [[ "${VOBIZ_SANDBOX_CLEAN:-}" != 1 ]]; then
  exec /usr/bin/env -i \
    VOBIZ_SANDBOX_CLEAN=1 \
    VOBIZ_BWRAP_BINARY="${VOBIZ_BWRAP_BINARY:-/usr/bin/bwrap}" \
    VOBIZ_CODEX_PACKAGE_ROOT="${VOBIZ_CODEX_PACKAGE_ROOT:-}" \
    VOBIZ_CODEX_ENTRY_REL="${VOBIZ_CODEX_ENTRY_REL:-}" \
    VOBIZ_NODE_BINARY="${VOBIZ_NODE_BINARY:-}" \
    PATH=/usr/bin:/bin \
    /bin/bash "$0" "$@"
fi

fail() { printf 'vobiz Codex sandbox: %s\n' "$1" >&2; exit 78; }

bwrap_bin="${VOBIZ_BWRAP_BINARY:-/usr/bin/bwrap}"
package="${VOBIZ_CODEX_PACKAGE_ROOT:-}"
entry="${VOBIZ_CODEX_ENTRY_REL:-}"
node="${VOBIZ_NODE_BINARY:-}"
[[ "$EUID" -ne 0 ]] || fail 'must run as an unprivileged user'
[[ "$bwrap_bin" = /* && -x "$bwrap_bin" ]] || fail 'VOBIZ_BWRAP_BINARY must be an executable absolute path'
[[ "$package" = /* && -d "$package" ]] || fail 'VOBIZ_CODEX_PACKAGE_ROOT must be an absolute directory'
[[ "$entry" != /* && -n "$entry" && "$entry" != *..* ]] || fail 'VOBIZ_CODEX_ENTRY_REL must stay inside the package'
[[ "$node" = /* && -x "$node" ]] || fail 'VOBIZ_NODE_BINARY must be an executable absolute path'

package="$(readlink -f -- "$package")"
entry_file="$(readlink -f -- "$package/$entry")"
node="$(readlink -f -- "$node")"
case "$entry_file" in "$package"/*) ;; *) fail 'Codex entry escapes package root' ;; esac
[[ -x "$entry_file" ]] || fail 'Codex entry is not executable'
case "$package" in
  /|/home|/home/chirag|*/.hermes|*/.hermes/*|*/.ssh|*/.ssh/*|*/.codex|*/.codex/*)
    fail 'Codex package path includes private home data' ;;
esac

mounts=(--ro-bind /usr /usr)
for system_path in /bin /lib /lib64; do
  if [[ -L "$system_path" ]]; then
    mounts+=(--symlink "$(readlink -- "$system_path")" "$system_path")
  elif [[ -e "$system_path" ]]; then
    mounts+=(--ro-bind "$system_path" "$system_path")
  fi
done
for config_path in /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/passwd /etc/group; do
  [[ -e "$config_path" ]] && mounts+=(--ro-bind "$config_path" "$config_path")
done
for cert_path in /etc/ssl/certs /etc/pki/tls/certs; do
  [[ -d "$cert_path" ]] && mounts+=(--ro-bind "$cert_path" "$cert_path")
done

exec "$bwrap_bin" \
  --unshare-all --share-net --new-session --die-with-parent \
  --clearenv \
  --proc /proc --dev /dev --tmpfs /tmp \
  --dir /etc --dir /etc/ssl --dir /etc/pki --dir /etc/pki/tls \
  --dir /runtime --dir /sandbox --dir /sandbox/home --dir /sandbox/codex-home \
  --dir /tmp/caller-codex-voice \
  "${mounts[@]}" \
  --ro-bind "$package" /runtime/codex \
  --ro-bind "$node" /runtime/node \
  --setenv PATH /runtime:/usr/bin:/bin \
  --setenv HOME /sandbox/home \
  --setenv CODEX_HOME /sandbox/codex-home \
  --setenv USER caller-voice \
  --setenv LOGNAME caller-voice \
  --setenv LANG C.UTF-8 \
  --chdir /tmp/caller-codex-voice \
  -- "/runtime/codex/${entry_file#"$package"/}" "$@"
