#!/usr/bin/env bash
set -euo pipefail

: "${WEBSSH_FIXTURE_PASSWORD:?WEBSSH_FIXTURE_PASSWORD is required}"
printf 'fixture:%s\n' "$WEBSSH_FIXTURE_PASSWORD" | chpasswd
mkdir -p /run/sshd
chmod 755 /run/sshd
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
