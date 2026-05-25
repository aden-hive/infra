#!/bin/bash
# Pack the Hive extension as a signed .crx, derive its extension ID from the
# public key, and write a Chrome managed-policy that force-installs it from
# a local HTTP update manifest.

set -eu

SRC=/opt/hive-extension
OUT=/opt/hive-ext-crx
mkdir -p "$OUT"

google-chrome-stable --no-sandbox --pack-extension="$SRC" 2>&1 | tail -5
[ -f /opt/hive-extension.crx ] || { echo "pack failed: no crx" >&2; exit 1; }
[ -f /opt/hive-extension.pem ] || { echo "pack failed: no pem" >&2; exit 1; }

mv /opt/hive-extension.crx "$OUT/hive.crx"
mv /opt/hive-extension.pem "$OUT/hive.pem"

EXT_ID=$(python3 - <<PY
import hashlib, subprocess
der = subprocess.check_output(
    ["openssl", "rsa", "-in", "$OUT/hive.pem", "-pubout", "-outform", "DER"],
    stderr=subprocess.DEVNULL,
)
h = hashlib.sha256(der).digest()[:16]
print("".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in h), end="")
PY
)
echo "EXTENSION_ID=$EXT_ID"
echo "$EXT_ID" > "$OUT/ext_id"

# Read the version straight from the manifest so update.xml never lies
# about what's actually in the .crx. Chrome refuses to force-install
# when the advertised version doesn't match the bundled manifest, so
# hardcoding (the prior behavior, 1.0.0) silently broke whenever the
# extension bumped — which is how the VM template ended up two versions
# behind the runtime.
EXT_VERSION=$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version'])")
echo "EXTENSION_VERSION=$EXT_VERSION"
echo "$EXT_VERSION" > "$OUT/ext_version"

cat > "$OUT/update.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$EXT_ID'>
    <updatecheck codebase='http://127.0.0.1:9999/hive.crx' version='$EXT_VERSION' />
  </app>
</gupdate>
XML

mkdir -p /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/hive-extension.json <<JSON
{
  "ExtensionSettings": {
    "$EXT_ID": {
      "installation_mode": "force_installed",
      "update_url": "http://127.0.0.1:9999/update.xml"
    }
  }
}
JSON

echo "policy written; extension $EXT_ID force-installed via http://127.0.0.1:9999/update.xml"
