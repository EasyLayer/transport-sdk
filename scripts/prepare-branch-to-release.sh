#!/bin/bash

# Stop the script on errors
set -e

# Constants
RELEASE_COMMIT_PATTERN="chore(release):"

# Get version type (e.g., patch, minor or major)
version=$VERSION

# ────────────────────────────────────────────────────────────────────────────────
# generate_changelog
#
# 1. Fetch all tags and update refs.
# 2. Determine the latest semantic version tag (vX.Y.Z).
# 3a. If no tag is found, generate the full changelog (-r 0).
# 3b. Otherwise, generate only the next release section (-r 1).
# ────────────────────────────────────────────────────────────────────────────────
generate_changelog() {
  # Fetch the latest commits and tags from main, then merge into current branch
  git fetch origin master --tags
  git merge --no-ff origin/master --no-edit

  # Retrieve the latest semantic version tag
  local latest_tag
  latest_tag=$(git tag --list --sort=-version:refname | head -n1)

  if [ -z "$latest_tag" ]; then
    echo "📝  No tags found. Generating full CHANGELOG…"
    node_modules/.bin/conventional-changelog -p angular -i CHANGELOG.md -s -r 0
  else
    echo "📝  Latest tag is $latest_tag — generating only the next release…"
    node_modules/.bin/conventional-changelog -p angular -i CHANGELOG.md -s -r 1
  fi
}

# ────────────────────────────────────────────────────────────────────────────────

# Update package version
echo "Setting package version to: $version"
npm version $version --exact --yes --no-git-tag-version --no-commit-hooks --force

# Get the version number from package.json
version_num=$(jq -r '.version' package.json)
echo "✨  New version is v$version_num"

# Generate or update CHANGELOG.md in one call
echo "📝  Generating CHANGELOG.md"
generate_changelog

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
  git commit -m "$RELEASE_COMMIT_PATTERN release v$version_num"
  git push origin HEAD
else
  echo "⚠️  No changes to commit"
fi

echo "✅  Preparing branch for v$version_num completed"
