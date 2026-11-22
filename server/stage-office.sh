#!/bin/sh
# Stage the private rendering modules next to office_render.py on the bridge host.
# Usage: sh server/stage-office.sh /path/to/office-engine RELEASE_REF OUTPUT_DIRECTORY
set -eu
repo=$1
revision=$2
output=$3
mkdir -p "$output"
git -C "$repo" archive --format=tar --output="$output/office-source.tar" "$revision" \
  app/config.py app/runtime.py app/office/build_docs.py app/office/xlsx_build.py \
  app/office/renderers/docx_build.js app/office/renderers/pptx_build.js
tar -xf "$output/office-source.tar" -C "$output"
cp "$(dirname "$0")/office_render.py" "$output/"
git -C "$repo" rev-parse "$revision" > "$output/renderer-revision"
