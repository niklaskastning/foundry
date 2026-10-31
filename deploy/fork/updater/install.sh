#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" != 0 ] || [ "$#" != 1 ]; then
  echo "Usage: sudo sh deploy/fork/updater/install.sh <local-user>" >&2
  exit 1
fi
case "$1" in
  ''|*[!a-zA-Z0-9_-]*) echo "Invalid local user" >&2; exit 1 ;;
esac
id "$1" >/dev/null
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
install -d -o root -g root -m 700 /etc/foundry-deploy /etc/foundry-deploy/docker /var/lib/foundry-deploy
install -o root -g root -m 600 "$source_dir/compose.yml" /etc/foundry-deploy/compose.yml
install -o root -g root -m 755 "$source_dir/foundry-deploy.py" /usr/local/sbin/foundry-deploy
/usr/local/sbin/foundry-deploy status
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT HUP INT TERM
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/foundry-deploy\n' "$1" > "$policy"
chmod 600 "$policy"
visudo -cf "$policy"
install -o root -g root -m 440 "$policy" /etc/sudoers.d/foundry-deploy
echo "Installed Foundry-only updater. No containers have been changed."
