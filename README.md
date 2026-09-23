# Self-Bootstrapping Categorizer

Discover useful task categories in arbitrary text without deciding the whole taxonomy first. This standalone Bun/TypeScript CLI pairs a reasoning-model curator with TypeSafe Jev: the curator proposes **names and definitions**, Jev judges records against those definitions, and ordinary code controls the workflow.

## Why discover categories?

A collection of support tickets, project requests or research abstracts often contains recurring tasks that its existing labels hide. Grouping by subject, tool or writing style can put unrelated outcomes together: refunding a payment and changing an invoice address both concern billing, but completing one does not complete the other.

The goal is to group **concrete tasks and outcomes**, including equivalent tasks expressed differently across domains. Categories have definitions with inclusions and exclusions, not just catchy names. A record can support several tasks while still having one primary task for browsing. This is a prompt-level goal—not something schema validation can guarantee.

## How classification works

1. **Start small.** The curator reads a bounded, reproducible sample and proposes at most 10 initial categories (fewer if the total limit is smaller). You can supply your own categories instead. Limits are ceilings, not quotas.
2. **Ask independent questions.** For each record, Jev returns a broad-domain **Choice**, a primary-task **Choice**, one membership **Noul** per known task, and a coverage-gap Noul for a substantive task outside all current definitions. Tasks are not filtered by domain; Choices do not consume sibling Noul answers.
3. **Respond to primary Other immediately.** A clear task outside the known definitions sends that record, its judgment and the current taxonomy to the curator. The curator may propose evidence-backed additions or no change. Other is a discovery signal, not proof of novelty.
4. **Validate, checkpoint, move forward.** Code checks proposal structure, evidence references, uniqueness and category limits. Growth is add-only: existing names and definitions stay unchanged. After an accepted addition, retry **only the triggering record once**, then continue in input order. There is **no model reviewer, historical replay or final consistency pass**.

### Why keep probabilities instead of just labels?

A Choice answers “which one?” and retains its full probability distribution plus a separate `confidence`. A Noul answers an independent yes/no question with a probability of yes: low membership means **likely nonmembership**, not uncertainty; values near the middle suggest ambiguity. Several tasks can have high membership even when only one is primary.

Keeping these signals separate exposes disagreements. Compare Other with the **maximum** known-task membership, not an average across unrelated categories. Coverage gaps and disagreement flags aid inspection, but **only primary-task Other triggers discovery**.

**Unclear** means insufficient evidence or no unique primary task. It does not automatically create a category. Neither low Other counts nor confident judgments establish correctness. See the [vision and design](vision.md) for the full semantics and tradeoffs.

## Install and run

Requires **Bun 1.3.14**. Clone the source and install its dependencies; there is no published package to install.

```sh
git clone https://github.com/jack-michaud/self-bootstrapping-categorizer.git
cd self-bootstrapping-categorizer
bun install --frozen-lockfile
bun src/cli.ts help
```

For live classification, supply `TYPESAFE_API_KEY` through your environment/credential manager. Discovery also needs a separately installed, compatible Hermes Python runtime with existing OpenAI Codex authentication. The default runtime location is `~/.hermes/hermes-agent` with `venv/bin/python`; set `hermesRuntimePath` in the JSON config if yours differs.

The [checked-in discovery config](examples/discovery-config.json) explicitly selects `hermes-native` / `openai-codex` / `gpt-6-astra`, rather than the underlying `gpt-5.4` default. Choose a model available to your account; availability is not guaranteed. Native calls use fresh, tool-free contexts, not a persistent agent conversation. Installing CLI dependencies does **not** install or execute skills described in source records.

```sh
bun src/cli.ts run --input examples/records.jsonl --run-dir runs/discovery \
  --config examples/discovery-config.json --max-categories 100 --allow-external
```

**`--allow-external` permits sending records, metadata and prompts to providers and may incur charges.** Keep credentials out of config files and Git. The example config allows 150 provider attempts, including failures; set `maxCalls` for your workload. The total category ceiling defaults to 100 and accepts integers from 1 to 253.

Input is JSONL: one object per line, with a unique `id`, nonempty `text` (up to 12,000 characters), and optional JSON-object `metadata`. Unknown top-level fields are rejected. Text is treated as data; the CLI does not follow record URLs or execute their instructions.

```jsonl
{"id":"ticket-1","text":"Please refund the duplicate payment on my last order."}
{"id":"ticket-2","text":"Update the billing address used for future invoices."}
```

Save your records as `records.jsonl` and substitute that path for the bundled synthetic example. `--input -` reads stdin. Each `run` needs a new run directory.

### CLI essentials

These are the core forms from `bun src/cli.ts help` (prefix each with `bun src/cli.ts`):

```text
run --input records.jsonl|- --run-dir runs/new [--config config.json]
    [--categories categories.json] [--seed-prompt file] [--curator-prompt file]
    [--judgment-prompt file] [--mode discovery|assessment] --allow-external
resume --run-dir runs/existing --allow-external
inspect --run-dir runs/existing
export --run-dir runs/existing --out new-directory
```

For a fixed taxonomy, use `--categories examples/categories.json --mode assessment` on `run`: Jev only, with no curator runtime/auth required. Manual categories are an array of `{id,name,description}`. In discovery mode, they skip seed generation but still allow additions. Full help also covers separate `eval`, `eval-resume` and `triplet` commands; deprecated reviewer/round settings do not enable a review stage.

## Example categorization briefs

Prompts are **files passed to the CLI**, not interactive chat commands. Start with copies of the [seed](prompts/seed.md), [curator](prompts/curator.md) and [judgment](prompts/judgment.md) prompts, then append the same corpus-specific brief to all three. Preserve their evidence, independence and add-only instructions.

| Corpus | Brief to append |
|---|---|
| Support tickets | “Group requests by the concrete resolution the customer needs, not product area or sentiment. Keep refunding a payment distinct from updating billing details. Do not infer a requested action from a vague complaint.” |
| Project requests | “Group by the deliverable that would satisfy the request, not department or software mentioned. Producing a forecast and building a reporting dashboard are distinct outcomes, even when they use the same data.” |
| Research abstracts | “Group by the concrete research task or outcome claimed, not the field or writing style. Distinguish measuring a phenomenon from predicting it. If the abstract gives no clear task, preserve Unclear rather than inventing one.” |

For example, copy the prompts, append the support-ticket brief in your editor, and save the JSONL above as `records.jsonl`:

```sh
cp prompts/seed.md seed-custom.md
cp prompts/curator.md curator-custom.md
cp prompts/judgment.md judgment-custom.md
# Append your brief to each copied file before running.
bun src/cli.ts run --input records.jsonl --run-dir runs/tickets \
  --config examples/discovery-config.json \
  --seed-prompt seed-custom.md --curator-prompt curator-custom.md \
  --judgment-prompt judgment-custom.md --allow-external
```

These are starting instructions, not promised category names or accuracy results. The curator must still ground its proposals in the supplied records. Keep expected evaluation answers out of these inputs and prompts.

## Inspect and export results

```sh
bun src/cli.ts inspect --run-dir runs/discovery
mkdir -p exports
bun src/cli.ts export --run-dir runs/discovery --out exports/discovery
# Continue an interrupted run using its frozen inputs/configuration:
bun src/cli.ts resume --run-dir runs/discovery --allow-external
```

`inspect` shows status, stop reason, pinned models and call count—not a per-record report. Export creates a **new** directory; its parent must already exist. Open the exported JSON files in your editor or JSON viewer:

- **`assignments.json`**: each record's primary/domain labels, `supportedTasks`, membership probabilities, coverage gap, Choice distributions/confidence, diagnostic flags and `taxonomyVersion`.
- **`taxonomies.json`**: category IDs, names and definitions at every version. Read each assignment against the version it actually saw, not just the final vocabulary. Earlier assignments are intentionally not rewritten.
- **`unresolved.json`**: flagged assignments at workflow completion, including Other, Unclear and signal disagreements—not just missing categories. For an interrupted run, inspect current assignments and progress in the manifest too.
- **`decisions.json`**: accepted proposals and validation decisions. **`assessments.json`** holds fixed-taxonomy assessment snapshots (normally empty for discovery).
- **`manifest.json`**: the full snapshot, original records, configuration/prompts, progress and call journal with requests, raw responses and failures. Assignment `evidenceKey` links to a call's `key`. The live run keeps this same journal at `runs/discovery/manifest.json`.

Count completed records from `data.progress` entries with `stage: "done"`; an assignment can exist while discovery/retry is still pending. `complete` means inputs exhausted, not a correct or converged taxonomy. `limited` and `blocked` identify budget/category limits or provider/validation failures. Other and Unclear can remain after completion.

Resume checks frozen source, prompts/configuration and adapter/runtime identities; it is not a way to silently change policy mid-run. Do not remove a stale lock without confirming its owner is dead. Runs and exports contain original text, raw responses and local paths: treat them as sensitive and keep them out of Git.

## Evaluation and known limitations

This is an **experimental categorizer, not a validated high-accuracy classifier**. Input order, seed coverage, category granularity and immutable early decisions matter. Add-only growth cannot repair an overly broad initial category. Deterministic validation checks structure, not semantic correctness; model isolation is not an adversarial OS sandbox.

Historical experiments—not rerun publication tests—failed the three-run quality gate: **90%, 100%, 100% accuracy and 90% all-three agreement**, against a 95% requirement for each. A later authorized run processed 2,664 records, but review identified 1,716 misbucketed into “Command and capability reference.” Completion and low Other counts were not quality success. Private benchmark/corpus evidence is not redistributed, so these historical observations are not independently reproducible from this export.

Offline checks: `bun test` and `bun run typecheck`. Subprocess tests need Python 3 at `/usr/bin/python3` and POSIX support (tested on Linux); they use synthetic fixtures, not live model calls. See [publication scope](docs/publication.md) for coverage, [vision](vision.md#evaluation-is-separate-from-discovery) for evaluation policy, and the [config schema](src/contracts.ts) for settings. Optional Pi authentication, native-runtime compatibility and execution bounds are described in the [adapter design](vision.md#isolated-curator-adapters).

No license has been selected. Public visibility is not an open-source license grant; dependencies retain their own licenses.
