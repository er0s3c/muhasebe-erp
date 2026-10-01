#!/usr/bin/env bash
# Muhasebe ERP kurulum sihirbazı (Linux/WSL). Ayrıntı ve seçenekler: ./install.sh --help
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer/install.sh" "$@"
