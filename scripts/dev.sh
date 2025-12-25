#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use the unified full-start script by default.
exec "${SCRIPT_DIR}/idev.sh"
