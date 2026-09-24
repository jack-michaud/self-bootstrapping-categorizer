# Editing the trie domain

The trie is an explicit mode, not a reinterpretation of historical flat runs. Jack owns categorization meaning; agents own infrastructure. The default semantics are generic. A task-oriented skill collection is one use case, not a global ontology.

## Your edit surface

| File / symbol | What you control | Example |
|---|---|---|
| `src/domain/trie.ts` / `Policy` | Depth, sibling/node/call ceilings, seed size, specific-distinction support threshold | `maxDepth: 1` stops at broad roots; `3` permits two refinements |
| `src/domain/trie.ts` / `decide`, `depthStop`, `resolveRefinement` | Root abstention, child outcomes, retry and parent-retention rules | A child Unclear returns `childUnclear`, never erases its parent |
| `src/domain/trie.ts` / `growthLimit`, `validateTree`, `validateProposal` | Add-only boundaries, evidence/link/unique-sibling invariants | Every proposal must link to the current parent and cite only the supplied record |
| `src/domain/prompts.ts` / `prompts` | All domain-specific judgment, seed and curator wording | A use-case brief can distinguish reviewing code from modifying code |
| `src/domain/prompts.ts` / `judgmentRequest`, `curatorPayload` | Independent questions, sibling menus, ancestor context and proposal contract | A grandchild sees its full ancestor definitions, not unrelated branches |
| Trie JSON config / `policy`, `prompts` | Run-specific declarative settings without source edits | Override `prompts.judgment` with a collection-specific brief |
| `--categories` JSON | Manual broad primary definitions, no model-generated roots | `{ "name": "Interprets code", "description": "Understands code; edits are not required." }` |

Domain code is pure TypeScript plus Zod validation. It never imports a filesystem, environment, network transport, provider SDK or persistent store. Shared `contracts.ts` contributes pure wire schemas/types, not clients. Defaults and prompt construction live here—not in provider adapters.

### Ownership convention for contributors

- Preserve Jack's manual domain edits; discuss changes to meaning unless explicitly requested. Add domain rule tests before changing behavior.
- Application (`src/application/trie.ts`) interprets typed decisions through `Ports`; it owns sequencing, not hidden judgment wording.
- Infrastructure (`src/infrastructure/trie.ts`, `providers.ts`, `curators.ts`, `store.ts`, CLI) owns auth, model pins, technical timeout/output safety, atomic files, locks and composition. Technical safety does not belong in editable classification rules.
- Do not duplicate the trie classifier in a skills explorer or consumer. Keep legacy flat commands compatible. No event bus, CQRS or class-per-rule framework is needed.

## Decision table

| Context / result | Action | Retained assignment |
|---|---|---|
| Root known sibling | Append immutable assignment step, descend if depth allows | Root and its actual taxonomy version |
| Root Other / Unclear | Finish this record; frozen roots cannot grow | Explicit `rootOther` / `rootUnclear` |
| Child known sibling | Append full path and actual version, descend | All ancestors plus selected child |
| No children | Ask explicit three-way refinement feasibility plus independent support Noul | Parent until a supported child is selected |
| Child stop-at-parent / Unclear | Finish as `stopAtParent` / `childUnclear` | Parent |
| Specific Other, support below threshold | Finish as `unsupportedSpecificOther` | Parent |
| Supported specific Other, limits permit | Curator sees current record, siblings, path and judgments | Parent while proposal is pending |
| No change | Finish `noChange` | Parent |
| Valid additions | Version children + checkpoint retry intent atomically; retry current record once at this parent | Parent until retry selects child |
| Retry still Other / Unclear | Finish `stillOther` / `childUnclear`; no second proposal | Parent |
| Node/sibling limit | Skip curator; finish record, run `limited` | Parent |
| Depth limit | Finish `maxDepth`; this is configured granularity, not failed discovery | Deepest known node |
| Call exhaustion | `limited`, current stage remains pending | Any known path and all evidence |
| Invalid schema/links/evidence/model identity or provider failure | `blocked`, never successful completion | Path, raw calls and any cleanup audit |

Choice winners and each independent membership/coverage/feasibility Noul are preserved without forcing agreement. Low membership is nonmembership, not uncertainty. An empty child list produces an outcome/feasibility Choice, **never an empty category Choice**; it has no vacuous coverage question. The feasibility support threshold gates only new-child discovery, not known-child Choice results.

IDs are code-generated path IDs (`n1`, `n1.1`, …). Definitions never change after introduction. New taxonomy versions retain prior nodes; each assignment step has its actual version, selected full path, raw probabilities and confidence. Prefix semantics are contextual: “interprets code / for code review / to simplify architecture” is a possible path, not a hardcoded universal taxonomy. Deterministic validation rejects links/cycles, duplicate siblings, invalid evidence, edits and caps; **it cannot prove semantic child-parent containment**.

## Run the synthetic example

```sh
bun src/cli.ts trie help
# External consent is required; these commands can spend inference when run normally.
bun src/cli.ts trie run --input examples/trie-records.jsonl \
  --categories examples/trie-primary.json --config examples/trie-config.json \
  --run-dir runs/trie-demo --allow-external
bun src/cli.ts trie inspect --run-dir runs/trie-demo
bun src/cli.ts trie export --run-dir runs/trie-demo --out exports/trie-demo
bun src/cli.ts trie resume --run-dir runs/trie-demo --allow-external
```

Create the export parent directory first. Omit `--categories` for curator-seeded broad roots from the first bounded `seedSize` records. The sample is deterministic input order, not representative sampling. Roots are strictly validated and frozen in a separate checkpoint before record classification. Manual definitions use `{name,description}` only; IDs are not accepted. Primary count is bounded by `primaryLimit` (1–10), sibling and total ceilings; none are quotas. Optional deeper exploration is controlled by `maxDepth`.

The example config uses existing provider adapters, not new backends. Use model names available to your account. Auth, timeouts and output-byte bounds live under `provider`; never put credentials in config. Source records and metadata are sent to providers only with `--allow-external`.

## Frozen policy and recovery

A snapshot contains exact domain, application, transport/store/CLI and shared-contract source bytes, the package/lock files, domain config and full prompt strings plus a policy hash. Input/config/policy/initial definitions are bound by the enclosing snapshot hash. Editing source policy—even comments—rejects resume; new configs cannot override a resumed run. Restore exact frozen source or start a new run. This conservative policy avoids silently reinterpreting historical evidence; hashes detect consistency, not malicious local tampering. Read-only inspect/export use frozen artifacts without executing historical code or rejudging assignments, even when current policy differs.

`manifest.json` contains `data.trie`: taxonomy versions, per-record path/steps, terminal reason, cursor, proposal decisions and ignored-target audits. `calls` retains raw requests/responses/errors. Exports include the complete manifest, taxonomies, assignments (with source metadata), and decisions. Count completed records using `cursor` / `stage: "done"`, not paths: a parent assignment can exist while refinement remains pending. Invalid responses remain in `calls` even when no validated step can be appended.

Only a nonempty **string** add target is ignored, after strict parsing. Its original value, action index, phase, parent, version and evidence-record IDs remain in the cleanup audit. This survives downstream rejection. Sources, operations, parent links, evidence and caps remain strict. Raw bytes are not rewritten.

Provider attempts are durably admitted before dispatch and count against `maxCalls`, including failures. Successful identical calls are cached within a run. Addition + retry stage are published in one atomic manifest replacement. Resume never replays earlier completed records or runs a final sweep/reviewer. A blocked run stays blocked on resume; fix the cause and create a new run rather than silently retrying a semantic or provider failure. Call-limited pending runs remain limited under their frozen budget.

The existing exclusive `.lock` fails closed after abnormal termination. Confirm its recorded process is dead before operator removal; never automatically delete a possibly live owner's lock. File writes use fsync, rename and directory fsync. A remote call completed but not durably received may be repeated on explicit interrupted resume: this is not exactly-once billing or a guarantee against filesystem/power failure.

## Offline checks

```sh
bun test tests/trie.test.ts tests/trie-workflow.test.ts tests/trie-cli.test.ts
bun test
bun run typecheck
```

The CLI tests spawn real CLI processes with **test-only injected local provider fixtures**. They verify manual/seeded initialization, persistence, inspect/export, completed resume, process death immediately after response and after taxonomy+retry publication, cleanup, blocked failures and policy mismatch. Stale test locks are removed only after the owned subprocess is confirmed exited. These are software-contract checks, not provider-authentication, semantic-quality or live-inference evidence.
