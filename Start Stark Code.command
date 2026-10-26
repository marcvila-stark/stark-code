#!/bin/zsh
set -e
cd "${0:A:h}"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi
export PATH="$PWD/node_modules/.bin:$PATH"
export electron_config_cache="$PWD/.tools/electron-cache"
export STARK_CODE_DESKTOP_DATA_DIR="$PWD/.stark-code/electron"
export STARK_CODE_TELEMETRY_ENABLED=false
export STARK_CODE_OTEL_SDK_DISABLED=true
export OTEL_SDK_DISABLED=true
export STARK_CODE_DISABLE_AUTO_UPDATE=1
exec npm run dev:desktop -- --home-dir "$PWD/.stark-code"
