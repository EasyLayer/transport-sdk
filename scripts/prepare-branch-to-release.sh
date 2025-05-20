#!/bin/bash

# Stop the script on errors
set -e

# Get version type (e.g., patch, minor or major)
version=$VERSION

# Update package version
echo "Setting package version to: $version"
npm version $version --exact --yes --no-git-tag-version --no-commit-hooks --force

# Get the version number from package.json
version_num=$(jq -r '.version' package.json)
echo "✨  New version is v$version_num"

# Generate/update CHANGELOG.md according to Conventional Commits
echo "📝  Generating CHANGELOG.md"
npm run changelog

# Generate docs/version_file documentation
DOCS_DIR="docs"
DOCS_SRC="DOCS.md"
DOCS_DEST="$DOCS_DIR/v$version_num.md"

# Ensure docs directory exists
mkdir -p "$DOCS_DIR"

# Copy and overwrite the versioned docs file
cp "$DOCS_SRC" "$DOCS_DEST"
echo "📄  Copied $DOCS_SRC to $DOCS_DEST"

# Commit all changes in a single commit (version bump, CHANGELOG, docs)
echo "🚀  Committing all changes"
git config user.name "github-actions"
git config user.email "github-actions@github.com"
git add \
  package.json \
  yarn.lock \
  CHANGELOG.md \
  "$DOCS_DEST"

# Only commit if there are staged changes
if ! git diff --cached --quiet; then
  git commit -m "chore(release): release v$version_num"
  git push origin HEAD
else
  echo "⚠️  No changes to commit"
fi

echo "✅  Preparing branch for v$version_num completed"