#!/bin/sh
# Stamp a new version so browsers fetch fresh files after each publish (GitHub Pages caches files for 10 minutes).
V=$(date -u +%Y%m%d%H%M)
sed -i -E "s/<html lang=\"en\"( data-version=\"[0-9]+\")?>/<html lang=\"en\" data-version=\"$V\">/" index.html
sed -i -E "s/(src=\"(config|fonts|cv-engine|app)\.js)(\?v=[0-9]+)?\"/\1?v=$V\"/g" index.html
echo "$V"
