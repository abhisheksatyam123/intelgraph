#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <WLAN_WORKSPACE_ROOT>"
  exit 1
fi

WLAN_WORKSPACE_ROOT="$1"
if [[ ! -d "$WLAN_WORKSPACE_ROOT" ]]; then
  echo "Workspace does not exist: $WLAN_WORKSPACE_ROOT"
  exit 1
fi

mkdir -p "$WLAN_WORKSPACE_ROOT/.intelligence-data/neo4j/data"
mkdir -p "$WLAN_WORKSPACE_ROOT/.intelligence-data/neo4j/logs"

export WLAN_WORKSPACE_ROOT
docker compose -f "docker-compose.intelligence.local.yml" up -d

echo "Started intelligence DBs for workspace: $WLAN_WORKSPACE_ROOT"
echo "Neo4j data:    $WLAN_WORKSPACE_ROOT/.intelligence-data/neo4j/data"
echo "Neo4j logs:    $WLAN_WORKSPACE_ROOT/.intelligence-data/neo4j/logs"
