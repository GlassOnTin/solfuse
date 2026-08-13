#!/usr/bin/env bash
# Bump the asset cache-buster before deploying.
#
# GitHub Pages serves everything with Cache-Control: max-age=600, so a fresh
# deploy stays invisible for ten minutes unless the URLs change. That is not a
# theoretical annoyance — it has already produced a false test result, where a
# working page looked broken because the browser was still running the previous
# app.js against the current index.html.
#
# Run this whenever app.js, worker.js or pipeline.js changes, then commit and
# push. index.html is the source of truth for the version; app.js passes its own
# ?v= on to worker.js, which passes it on to pipeline.js.
set -euo pipefail
cd "$(dirname "$0")/.."

cur=$(grep -oE 'app\.js\?v=[0-9]+' index.html | grep -oE '[0-9]+$')
next=$((cur + 1))

sed -i -E "s/(app\.js\?v=)[0-9]+/\1$next/" index.html
# selftest.html loads the worker directly, and may not exist yet.
[ -f selftest.html ] && sed -i -E "s/(worker\.js\?v=)[0-9]+/\1$next/" selftest.html

echo "asset version $cur -> $next"
grep -nE '\?v=[0-9]+' index.html $([ -f selftest.html ] && echo selftest.html)
