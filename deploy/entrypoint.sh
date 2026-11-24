#!/bin/sh
set -eu

if [ "$(id -u)" = 0 ]; then
    mkdir -p "$PAPERCOLAB_DATA"
    chown node:node "$PAPERCOLAB_DATA"
    chmod 0700 "$PAPERCOLAB_DATA"
    exec gosu node "$@"
fi

exec "$@"
