# Vision: self-bootstrapping categorization

## Implementation modes

The original flat workflow described below remains available unchanged in its categorization semantics. The explicit `trie` CLI adds a broad-first state machine with pure, human-owned domain rules and prompts, application ports, and infrastructure adapters. See [the domain guide](docs/domain-guide.md) for its current decision table, source/policy snapshots, operational commands and ownership. It freezes roots before classification, uses sibling-only ancestor-scoped judgments, and preserves parent assignments through bounded current-record refinement. No runtime reviewer, earlier-record replay or final sweep is introduced. Offline fixtures verify execution contracts, not classification quality.

## Purpose and scope

Discover useful categories for arbitrary text without requiring the user to know the complete taxonomy in advance. A reasoning-model curator proposes evidence-backed categories; TypeSafe Jev supplies typed judgments; ordinary code owns execution and validation. The product is a standalone, resumable Bun/TypeScript CLI and library, not a persistent agent conversation or hosted service.

This document adapts the original project vision for public distribution and describes the published implementation. The skill-categorization experiments motivated the design but are not hardcoded product behavior. Private corpus text, benchmark answers, experiment artifacts and project-management details are not redistributed. See the [README](README.md) for operation and observed limitations, and [publication scope](docs/publication.md) for what is included.

**Completion is not quality validation.** The workflow can exhaust its inputs while producing an unsuitable taxonomy. Its design makes decisions inspectable; it does not establish that the decisions are correct.

## User contract

- Accept JSONL records with stable, unique `id`, nonempty `text`, and optional JSON-object `metadata`, from a file or stdin. Strict schemas reject unknown top-level fields; text is limited to 12,000 characters.
- Generate an initial taxonomy from a bounded, reproducible discovery sample, or accept manual categories as `{id, name, description}`. Descriptions carry scope and exclusions.
- Allow separate seed, iterative curator and judgment prompts so domain context and desired task granularity are explicit.
- Expose provider/model selection and bounded execution without embedding credentials in configuration.
- Support `run`, `resume`, `inspect` and `export`, with versioned taxonomies, assignments, probabilities, proposals, decisions and call evidence.
- Require explicit consent through `--allow-external` before sending records, metadata and prompts to providers.

The bundled prompts and judgment questions favor concrete task/outcome categories, with multiple supported tasks and one primary task for browsing. That orientation grew out of the [Claude-skills case study](evals/skill-categorizer-by-task/README.md), not a universal task taxonomy. Users can configure prompts and category definitions, but should account for the task-oriented wording retained in the current judgment protocol. Semantic suitability cannot be proved by schema validation.

## Roles and authority

| Component | Authority | Boundary |
|---|---|---|
| Runner | Input validation, state transitions, budgets, locks, caching, taxonomy versions and exports | Models cannot rewrite orchestration or grant themselves tools |
| Jev | Broad-domain Choice, primary-task Choice, task-membership Nouls and coverage-gap Noul | Does not invent category names or mutate the taxonomy |
| Curator | Propose initial categories and evidence-backed additions | No runtime reviewer; proposals must pass deterministic validation |
| Evaluation normalizer | Map generated definitions to reference definitions in a separate call | Cannot veto runtime additions or see per-record expected answers |
| Operator | Choose inputs, prompts, models, budgets and manual categories | Quality-policy changes and larger experiments remain explicit decisions |

The implementation seams are [contracts](src/contracts.ts), [workflow](src/workflow.ts), [providers](src/providers.ts), [curator adapters](src/curators.ts), [persistence](src/store.ts), [evaluation](src/evaluation.ts) and [CLI](src/cli.ts). Injected providers are trusted application code, not plugins selected by source records.

## Independent Jev judgments

The classification unit is **one record against one immutable taxonomy version**. A single Jev request contains the record, current category definitions, taxonomy version and categorization context in `state`, with independent typed questions in `questions`.

| Judgment | Meaning |
|---|---|
| Domain Choice | Broad subject domain, with `other` and `unclear`; domain vocabulary is configurable |
| Primary-task Choice | One concrete primary outcome, with `other` for a clear task outside known definitions and `unclear` for insufficient evidence or no unique primary task |
| Membership Noul per known task | Probability that the record substantively supports that task, independently of the primary Choice |
| Coverage-gap Noul | Probability that a substantive primary or secondary task is outside all current definitions |

The runner asks about the complete known task vocabulary; it does not prefilter tasks by the domain Choice. Choices never consume sibling Noul answers. A new task can belong to an existing domain, and a known primary task can coexist with an uncovered secondary task.

Retain each Choice's winner, complete probability distribution and separate `confidence`. A Noul's `noul` value is the probability of yes: low means likely nonmembership, while values near the middle indicate ambiguity. There is no separate Noul confidence field. Preserve memberships individually and compute maximum known membership, not their average: averaging unrelated labels confounds the signal with vocabulary size.

Configurable thresholds produce supported-task displays and diagnostic flags for coverage gaps, uncertain judgments and Choice/membership disagreement. These are provisional policies, not calibrated guarantees. Do not overwrite Choice results to force agreement with Nouls. **Only primary-task Other triggers adaptive discovery**; Unclear, Other domain, high gap and disagreement remain diagnostics, not automatic novelty triggers.

The default endpoint is `https://api.typesafe.ai/v1/systemone`. Explicit version requests must match the first response; the explicitly selected `jev-latest` alias resolves once to a version and later calls reject drift. Prefer pinned models for experiments. The [example configuration](examples/discovery-config.json) selects `jev-latest` and native `gpt-6-astra`; pin an explicit Jev version for reproducibility. Underlying defaults are `jev-latest` and curator `gpt-5.4`. Those defaults are not a claim of verified model availability or quality.

## Initialization and taxonomy limits

1. Validate inputs/configuration and snapshot input, source, prompt and adapter/runtime identities.
2. Use manual categories, or hash-sort records and select up to `sampleSize` records for seed generation (default 40). This bounded sample is reproducible, not guaranteed diverse, representative or repository-stratified.
3. Generated seeds contain at most `min(10, maxCategories)` categories. An empty seed blocks initialization rather than proceeding with no task vocabulary.
4. The total taxonomy ceiling defaults to 100. `maxCategories` / `--max-categories` accepts integers from 1 to 253, within the current Choice transport ceiling. Manual categories bypass only the generated-seed ceiling.
5. Validate names, IDs, definitions, collisions and reserved values before classification. Communicate effective phase limits to the curator before dispatch.

Limits are ceilings, not quotas. Do not invent categories or broaden their definitions to fill a quota. Task growth occurs incrementally after initialization; the domain vocabulary is configured separately.

## Add-only roll-forward discovery

```text
INITIALIZE -> CLASSIFY CURRENT RECORD
                  |
          primary Other? -- no --------------------> ADVANCE
                  |
          total cap reached? -- yes -> LIMITED OUTCOME -> ADVANCE
                  |
          CURATE CURRENT RECORD + JUDGMENT + TAXONOMY
                  |
          STRICT PARSE -> VALIDATE ADD-ONLY PROPOSAL
                  |
          empty proposal? -- yes -> NO CHANGE ------> ADVANCE
                  |
          CHECKPOINT NEW TAXONOMY + RETRY INTENT
                  |
          RETRY ONLY CURRENT RECORD ONCE -----------> ADVANCE

RECORDS EXHAUSTED -> TERMINAL STATUS / EXPORT; NO FINAL PASS
```

On primary Other, dispatch the curator immediately rather than collecting a corpus-wide queue. The iterative payload includes the current record, its independent judgment and the current taxonomy. Only that record's ID is valid refinement evidence. Other is a discovery signal, not proof that a category is missing; an empty proposal is a valid decision.

Existing category IDs, names and definitions are immutable. There is **no model reviewer, no replay of historical assignments, and no final consistency pass**. At most one proposal and one accepted-proposal retry occur per record. A still-Other retry persists and advances rather than starting another discovery loop. At the category cap, skip curator dispatch but continue classifying remaining records within the call budget; the terminal outcome is `limited` / `category_limit` if a record encountered that restriction.

### Proposal validation and narrow target cleanup

The curator returns one strict JSON object containing an `actions` array. Each action carries `op`, `target`, `sources`, `name`, `description`, `evidence` and `reason`. The advertised add-only contract uses literal `op: "add"`, `target: ""` and `sources: []`.

After parsing the **entire JSON and strict proposal schema**, reject non-add operations. Only in this roll-forward path, clear a nonempty string `target`: category IDs are generated by code, so an add target has no authority. Preserve the raw provider response and journal `originalTarget` with the zero-based `actionIndex`, phase and version in `ignoredAddTargets` before downstream validation. This journal remains even if a later check rejects the proposal.

This is not general JSON repair. Missing/non-string targets, nonempty sources, unknown evidence, duplicate/reserved names or IDs, and category-cap violations still fail. Evidence references must belong to the supplied records; deterministic checks do not prove that a model's semantic justification is sound. The older library utility `applyProposal` can handle revise/merge for other callers, but remains strict about add targets; it does not define or loosen the discovery loop's policy.

### Historical assignments retain their meaning

An assignment records the taxonomy version actually used. Earlier Choices and coverage probabilities describe that earlier candidate menu, not the final expanded vocabulary. They are intentionally not rewritten when categories are added. Evaluation accepts an older-version category assignment only if its category existed at the recorded version and its definition remains unchanged. A mixed-version run is expected, not inherently stale.

This preserves auditability and bounds inference cost, at the expense of order dependence and the inability to repair poor early assignments or overly broad initial categories within the same run.

## Bounded execution, checkpoints and recovery

The runner, not a persistent agent, owns progress stages (`classify`, `propose`, `retry`, `done`). Taxonomy application and retry intent are written in one atomic checkpoint so a resume does not apply the same accepted proposal twice. The store uses an exclusive run lock and writes/fsyncs a temporary manifest before atomic rename and directory fsync.

`maxCalls` defaults to 200 and counts persisted provider attempts, including failed calls. Admission is recorded before dispatch. Plan budgets for seed generation, initial classifications, immediate curator calls and triggering-record retries, not repeated full sweeps. A budget limit can leave an accepted taxonomy checkpoint awaiting its retry. Completed records must be counted from `progress.stage === 'done'`, not merely the existence of an assignment.

Successful identical calls are cached only within their run identity. Snapshots bind inputs, configuration, prompts and source; curator calls additionally check adapter/runtime identity. Resume uses saved configuration and rejects incompatible identities. Historical failures remain in call evidence even when transient workflow failure fields are reset for an explicit resume. A request completed remotely but lost before durable response may be billed again: this is **not exactly-once provider execution**.

Terminal outcomes distinguish record exhaustion, category/call limits and provider/validation failures. Other and Unclear may remain even in a completed run. Deprecated `maxRounds`, `review` and reviewer-prompt settings are accepted for compatibility/provenance but do not enable review or rounds. A stale lock after abnormal exit requires operator reconciliation, not automatic deletion of a potentially live owner's lock.

## Curator provider

The Pi SDK is the sole curator backend. It uses existing Pi authentication, disables tools, extensions, skills, prompt templates, themes and project context files, and supplies the frozen system prompt plus curator payload. Pi's `SessionManager` persists the conversation transcript locally; the run journal stores the session ID and uses it to resume the same curation conversation. The session ID is not provider-server-side storage.

Curator calls have time and output bounds, and `maxTokens` applies to Pi. These controls do not guarantee token charges or constitute an adversarial OS sandbox. Treat the installed Pi SDK and injected provider implementations as trusted dependencies.

See [seed instructions](prompts/seed.md), [curator instructions](prompts/curator.md) and [judgment instructions](prompts/judgment.md).

## Evaluation is separate from discovery

Fixed-taxonomy `assessment` requires manual initial categories and measures independent signals without a curator. Adaptive `discovery` measures end-to-end seed generation and roll-forward growth. Results from a changing vocabulary do not establish fixed-taxonomy correlations between maximum membership and Other.

For evaluation, a separate Jev Choice sees only a generated category's name/description and a frozen rubric, with reference definitions plus `no_match` and `ambiguous` as criteria. It does not receive input records, per-record IDs/expected answers, classifier scores or curator history. Deterministic scoring joins category mappings back to predictions afterward. The [normalization prompt](prompts/normalization.md) requires equivalent purpose and scope, not shared keywords or partial overlap; compound categories should not arbitrarily receive credit for one constituent task.

The default `normalizationMinWinningProbability` is **0.95**, applied to the selected option's `probabilities[choice]`, not Choice `confidence`. Preserve raw low-probability responses but abstain from assigning a reference label. Other, Unclear, invalid assignments, no-match, ambiguous and abstained mappings remain incorrect in the full denominator; invalid labels never earn agreement. This policy is separate from membership Noul thresholds and is not a universal calibration claim.

The acceptance protocol uses three fresh bootstrap runs under frozen inputs, prompts, source, configuration, models, reference truth and normalizer policy, with no cross-run inference-result reuse. Each run must achieve at least 95% primary accuracy, and at least 95% of records must have valid identical normalized labels across all three runs. Report pairwise and within-reference-group agreement and raw taxonomy differences as diagnostics. Do not select only favorable attempts or silently retry failures. A failed gate means report and discuss; larger experiments require explicit authorization rather than automatic optimization until a pass.

Same-model normalization is not independent human validation. Inspect category scope even when a numeric gate passes. Benchmark-informed prompt/threshold changes are tuning, not held-out evidence. The historical roll-forward triplet reported **90%, 100%, 100% accuracy and 90% all-three agreement: FAIL**. The later explicitly authorized whole-corpus run completed but showed substantial misbucketing; neither completion nor low Other counts establishes category quality. [Historical limitations](README.md#evaluation-and-known-limitations) remain separate from offline software-contract tests. Private benchmark material is not bundled, so those historical results are not independently reproducible from this export alone.

## Privacy, limitations and non-goals

Treat source text as untrusted data, never instructions. The CLI does not execute source capabilities, follow record URLs or grant the curator shell access. Nevertheless, prompt-level boundaries cannot guarantee freedom from semantic prompt injection or provider errors. External consent includes potential provider charges; a custom Jev endpoint receives the API key and must be trusted. Redirects are refused.

Run manifests and exports retain original records, metadata, raw model responses and local provenance. They may contain sensitive information even though the source repository is publication-safe. Keep credentials and generated runs out of Git; review artifacts before sharing. This design does not claim anonymization or provider-side retention guarantees.

Initial scope excludes hosted deployment, autonomous code editing, installation/execution of source skills, persistent agent scheduling, unlimited ontology refinement and demonstrating that skills improve downstream agent performance. Hierarchical task routing or multi-record inference batching would need separate isolation and accuracy evidence before replacing the full-vocabulary, one-record baseline. No license choice or permission to redistribute third-party source material is implied by public visibility.
