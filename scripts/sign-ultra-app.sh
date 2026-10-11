#!/bin/bash
# Re-sign a locally packed PI-Ultra with a certificate that stays the same
# from one build to the next.
#
# electron-builder signs the local build ad hoc. macOS identifies an ad hoc
# app by a hash of its code, so every rebuild is a different app to it and the
# privacy grants the last one earned (the Desktop and Documents folders, the
# microphone) are asked for again. Signed with a certificate, the app is
# identified by its bundle id and that certificate instead, and a rebuild
# keeps its grants.
#
# The certificate is a self-signed "Code Signing" one made once in Keychain
# Access. It proves nothing to anyone else; it only gives this machine a
# stable name for the app. Without it this script leaves the ad hoc build as
# it is, which still runs.
set -euo pipefail

app="${1:?usage: sign-ultra-app.sh <path to .app>}"
identity="${PI_ULTRA_SIGN_IDENTITY:-PI-Ultra Dev}"

if [ ! -d "$app" ]; then
  echo "sign-ultra-app: $app does not exist" >&2
  exit 1
fi
if ! security find-identity -p codesigning 2>/dev/null | grep -Fq "\"$identity\""; then
  echo "sign-ultra-app: no \"$identity\" certificate in the keychain; leaving the ad hoc signature"
  exit 0
fi

sign() {
  # Each item keeps the entitlements and hardened-runtime flag it was built
  # with: Electron needs its JIT entitlements, and the helpers have their own.
  codesign --force --preserve-metadata=entitlements,flags --sign "$identity" "$@"
}

# Code that `--deep` does not reach: native modules and the host binary live
# under Resources. They are signed first because the bundle's seal covers them.
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q "Mach-O"; then
    sign "$file"
  fi
done < <(find "$app/Contents/Resources" -type f \( -name "*.node" -o -name "*.dylib" -o -perm -u+x \) -print0)

sign --deep "$app"
codesign --verify --deep --strict "$app"
echo "sign-ultra-app: signed $(basename "$app") as \"$identity\""
