---
tags:
  - status/wip
  - derived/module-intent-mapper
description: Intent mapper—bridges intelligence queries to fixture relation arrays via intent-to-bucket mapping
owner: wlan
---


# module-intent-mapper

## Index

- [Index](#index) — L12
- [Meaning](#meaning) — L21
- [Data flow](#data-flow) — L27
- [Purpose](#purpose) — L38
- [Data structures](#data-structures) — L42
- [API surface](#api-surface) — L100

## Meaning

Maps each intelligence_query intent (who_calls_api, what_api_calls, find_api_logs, etc.) to its corresponding fixture relation bucket. For example: who_calls_api → calls_in_direct, what_api_calls → calls_out, find_api_struct_writes → structures.

This mapping forms the contract between query intents and how backend responses should be compared against fixture data.

## Data flow

Exports:
- mapIntentToArray(intent: QueryIntent): RelationArrayName — maps any intent to its fixture bucket
- selectIntentsForApi(apiName, fixture): QueryIntent[] — determines which intents should be queried for a given API (currently: all core intents)
- generateContractFromRelations(relations): Contract — derives expected contract from populated arrays
- Deduplication utilities for relation normalization
- Type definitions: ApiFixture, Relations, Relation, Contract, EnrichmentMetadata

Used by exhaustive-relation-scanner to query backends and normalize their results into fixture-compatible buckets.

## Purpose

The intent mapper bridges queries (intents from the intelligence API) to fixture relation arrays. It defines which intents populate which relation buckets, selects applicable intents per API, and normalizes query results into fixture structure.

## Data structures

**Source**: `src/fixtures/intent-mapper.ts`

**Intent → Array mapping**: 
Each QueryIntent maps to a RelationArrayName (one of: calls_in_direct, calls_in_runtime, calls_out, registrations_in, registrations_out, structures, logs, owns, uses).

Examples:
- `who_calls_api` → `calls_in_direct`
- `who_calls_api_at_runtime` → `calls_in_runtime`
- `what_api_calls` → `calls_out`
- `find_api_logs` → `logs`
- `find_struct_writers` → `structures`

**ApiFixture structure**:
```
{
  kind: "api" | "struct" | "ring" | ...
  kind_verbose: string
  canonical_name: string
  aliases: string[]
  source: { file: string; line: number }
  description: string
  relations: {
    calls_in_direct: Relation[]
    calls_in_runtime: Relation[]
    calls_out: Relation[]
    registrations_in: Relation[]
    registrations_out: Relation[]
    structures: Relation[]
    logs: Relation[]
    owns: Relation[]
    uses: Relation[]
  }
  contract?: Contract
  enrichment_metadata?: EnrichmentMetadata
}
```

**Relation structure**:
```
{
  caller?: string
  callee?: string
  api?: string
  struct?: string
  field?: string
  edge_kind: string
  edge_kind_verbose: string
  derivation: "clangd" | "runtime" | ...
  confidence: number (0-1)
  evidence?: { kind: string; loc?: { file: string; line: number } }
  dispatch_chain?: string[]
  runtime_trigger?: string
  ...
}
```

## API surface

**Main functions**:
- `mapIntentToArray(intent: QueryIntent) → RelationArrayName`: Map a single intent to its target relation array
- `selectIntentsForApi(apiName: string, fixture: ApiFixture) → QueryIntent[]`: Determine which intents apply to a given API based on role heuristics
- `normalizeEdge(edge: any) → Relation`: Convert backend edge to fixture Relation with standardized fields
- `deduplicateRelations(relations: Relation[]) → Relation[]`: Remove duplicates, keep highest confidence
- `generateContractFromRelations(relations: Relations) → Contract`: Build verification contract from populated relations
