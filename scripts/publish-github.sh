#!/usr/bin/env bash
# Create github.com repo for this project and push main (no Qualcomm remote).
# Prereq: SSH to github.com works (ssh -T git@github.com).
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

REPO="${1:-clangd-mcp}"
VIS="${2:-private}"
OWNER="${GITHUB_OWNER:-abhisheksatyam123}"

cd "$(dirname "$0")/.."

token_auth() {
  [[ -n "${GITHUB_TOKEN:-}" ]] || [[ -n "${GH_TOKEN:-}" ]]
}

create_via_api() {
  local token="$1"
  local private_json="true"
  [[ "$VIS" == "public" ]] && private_json="false"
  local code
  code=$(curl -sS -o /tmp/gh-repo-check.json -w "%{http_code}" \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${OWNER}/${REPO}")
  if [[ "$code" == "200" ]]; then
    echo "Repository ${OWNER}/${REPO} already exists on GitHub."
    return 0
  fi
  if [[ "$code" != "404" ]]; then
    echo "GitHub API error checking repo (HTTP ${code}):" >&2
    cat /tmp/gh-repo-check.json >&2 || true
    exit 1
  fi
  curl -sS -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/user/repos \
    -d "{\"name\":\"${REPO}\",\"private\":${private_json}}"
  echo
}

push_ssh() {
  git remote remove origin 2>/dev/null || true
  git remote add origin "git@github.com:${OWNER}/${REPO}.git"
  git push -u origin main
}

if token_auth; then
  TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  create_via_api "$TOKEN"
  OWNER="$OWNER" push_ssh
  exit 0
fi

if gh auth status >/dev/null 2>&1; then
  if gh repo view "${REPO}" >/dev/null 2>&1; then
    LOGIN=$(gh api user -q .login)
    OWNER="$LOGIN"
    push_ssh
  else
    if [[ "$VIS" == "public" ]]; then
      gh repo create "${REPO}" --public --source=. --remote=origin --push
    else
      gh repo create "${REPO}" --private --source=. --remote=origin --push
    fi
  fi
  exit 0
fi

echo "Not authenticated for GitHub API. Do one of the following:" >&2
echo "" >&2
echo "  1) Browser / device (then re-run this script):" >&2
echo "       gh auth login --hostname github.com -p ssh --skip-ssh-key" >&2
echo "       $0 ${REPO} ${VIS}" >&2
echo "" >&2
echo "  2) Personal access token (classic: repo scope):" >&2
echo "       export GITHUB_TOKEN=ghp_..." >&2
echo "       $0 ${REPO} ${VIS}" >&2
exit 1
