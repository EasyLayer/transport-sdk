#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Publish package with default "latest" tag
echo "Publishing package with tag: latest"
./node_modules/.bin/npm publish --no-git-tag-version --yes --force
if [ $? -ne 0 ]; then
    echo "npm publish failed!"
    exit 1
fi

echo "✅  Release has published successfully."
