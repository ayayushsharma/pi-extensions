#!/usr/bin/env bash
# Child-pi wrapper that also loads the dialog fixture extension (tests only).
exec "${PI_HUB_TEST_REAL_PI:-pi}" -e "$(cd "$(dirname "$0")" && pwd)/dialog-ext.ts" "$@"
