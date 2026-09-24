# Self-Bootstrapping Categorizer

Turn a collection of text into defined, inspectable categories—without writing the whole taxonomy first. This Bun/TypeScript CLI starts with a small set of categories, discovers additions as it reads, and exports labels, probabilities and the evidence behind each decision.

A reasoning-model curator proposes names and definitions; [TypeSafe Jev](https://typesafe.ai) classifies records; ordinary code controls validation, budgets and checkpoints. Bring your own JSONL, categorization prompts or starting categories.

## Quickstart

Requires **Bun 1.3.14**. Clone and install the pinned dependencies; there is no published package:

```sh
git clone https://github.com/jack-michaud/self-bootstrapping-categorizer.git
cd self-bootstrapping-categorizer
bun install --frozen-lockfile
bun src/cli.ts help
```

For live classification, supply `TYPESAFE_API_KEY` through your environment or credential manager. Discovery also requires a separately installed, compatible **Hermes Python runtime** with existing OpenAI Codex authentication. The default runtime is `~/.hermes/hermes-agent`, using `venv/bin/python`; set `hermesRuntimePath` in your JSON config if it differs. See [adapter requirements and alternatives](vision.md#isolated-curator-adapters).

The [example config](examples/discovery-config.json) selects `hermes-native`, `openai-codex`, `gpt-6-astra` and `jev-latest`, with a 40-record seed sample, 100-category ceiling and 150 provider-attempt budget. Choose models available to your account; availability is not guaranteed. Failed attempts count toward the budget. Keep credentials out of config files.

Run the bundled synthetic example:

```sh
bun src/cli.ts run --input examples/records.jsonl --run-dir runs/discovery \
  --config examples/discovery-config.json --max-categories 100 --allow-external
```

**`--allow-external` permits sending records, metadata and prompts to providers and may incur charges.** Installing this CLI does not install or execute capabilities described in its input records.

### Use your own records

Save one JSON object per line as `records.jsonl`. Each needs a unique `id`, nonempty `text` (at most 12,000 characters), and optional JSON-object `metadata`; unknown top-level fields are rejected.

```jsonl
{"id":"ticket-1","text":"Please refund the duplicate payment on my last order."}
{"id":"ticket-2","text":"Update the billing address used for future invoices."}
```

Substitute `records.jsonl` for the example input, or use `--input -` for stdin. Each `run` needs a new run directory.

### Customize the categorization

Copy the [seed](prompts/seed.md), [curator](prompts/curator.md) and [judgment](prompts/judgment.md) prompts, then edit them for your collection. These are files, not interactive chat commands. The bundled prompts and judgment protocol favor concrete tasks; this is the current default orientation, not a universal taxonomy. Preserve their evidence, independent-judgment and add-only contracts, and account for the protocol's task-oriented wording when changing the brief.

```sh
cp prompts/seed.md seed-custom.md
cp prompts/curator.md curator-custom.md
cp prompts/judgment.md judgment-custom.md
# Edit all three files with the same categorization brief before running.
bun src/cli.ts run --input records.jsonl --run-dir runs/custom \
  --config examples/discovery-config.json \
  --seed-prompt seed-custom.md --curator-prompt curator-custom.md \
  --judgment-prompt judgment-custom.md --allow-external
```

To classify against a **fixed taxonomy**, use assessment mode. This needs only Jev authentication, not a curator runtime:

```sh
bun src/cli.ts run --input examples/records.jsonl --run-dir runs/assessment \
  --categories examples/categories.json --mode assessment --allow-external
```

Manual categories are an array of `{id,name,description}`. In discovery mode, `--categories` skips seed generation but still permits additions. See `bun src/cli.ts help` for all commands and the [config schema](src/contracts.ts) for settings.

## Broad-first trie mode

For hierarchical categories with human-editable domain rules, use the explicit `trie` command. It freezes broad roots, classifies among siblings with full ancestor context, and refines only the current record. A valid parent remains an assignment when refinement is uncertain or unnecessary. The flat commands below retain their existing behavior.

```sh
bun src/cli.ts trie help
bun src/cli.ts trie run --input examples/trie-records.jsonl \
  --categories examples/trie-primary.json --config examples/trie-config.json \
  --run-dir runs/trie-demo --allow-external
bun src/cli.ts trie inspect --run-dir runs/trie-demo
```

These run commands use live providers and can incur charges. Omit `--categories` for curator-seeded roots. See the [domain guide](docs/domain-guide.md) for Jack's exact edit surface, ownership, decision table, configuration, export/resume and offline fixture tests. Policy edits create new conditions; incompatible runs are never silently migrated.

## Inspect and export

```sh
bun src/cli.ts inspect --run-dir runs/discovery
mkdir -p exports
bun src/cli.ts export --run-dir runs/discovery --out exports/discovery
# Continue an interrupted run with its frozen inputs and configuration:
bun src/cli.ts resume --run-dir runs/discovery --allow-external
```

`inspect` reports status, stop reason, pinned models and call count. Export creates a **new directory** whose parent must exist:

| File | What to inspect |
|---|---|
| `assignments.json` | Primary/domain labels, supported categories, probabilities, diagnostic flags and each record's `taxonomyVersion` |
| `taxonomies.json` | Category names and definitions at every version; use the version each assignment actually saw |
| `unresolved.json` | Other, Unclear and signal disagreements flagged at completion |
| `decisions.json` | Proposals and validation decisions |
| `assessments.json` | Fixed-taxonomy assessment snapshots; normally empty for discovery |
| `manifest.json` | Full snapshot, original records, configuration/prompts, progress and raw provider-call journal |

Count finished records from manifest `data.progress` entries with `stage: "done"`; an assignment can exist while its retry is pending. `complete` means inputs exhausted, **not** a correct taxonomy. `limited` and `blocked` distinguish limits from provider/validation failures. Resume checks frozen source and runtime identities; it cannot silently change policy. Do not remove a stale lock without confirming its owner is dead.

**Runs and exports contain source text, raw responses and local paths. Keep them out of Git and review before sharing.**

## How it works

1. **Seed:** the curator reads a bounded, reproducible sample and proposes at most 10 categories, or you supply initial categories. The total category ceiling defaults to 100 and accepts 1–253.
2. **Classify:** Jev independently chooses a broad domain and a primary category, and estimates membership in every known category plus uncovered-task probability. Domain does **not** filter the category menu. The exported primary label is `primary`; membership-derived labels are `supportedTasks`.
3. **Discover:** primary **Other** immediately sends the current record and taxonomy to the curator. It may propose evidence-backed additions or no change. **Unclear** means insufficient evidence or no unique primary answer; it does not trigger discovery.
4. **Checkpoint and advance:** code validates proposals. After an accepted addition, retry **only the triggering record once**, then move forward. Existing definitions and earlier assignments stay unchanged. There is no model reviewer, historical replay or final consistency pass.

A **Choice** retains one selected answer and its probability distribution. Each **Noul** is an independent probability of yes: low membership means likely nonmembership, not uncertainty. These signals make disagreements inspectable; they do not prove correctness. See the [vision and design](vision.md) for semantics, adapters and evaluation policy.

## Evaluation and known limitations

This is an **experimental categorizer**, not a validated high-accuracy classifier. Input order, seed coverage and category granularity matter. Add-only growth cannot repair overly broad early categories. Deterministic validation checks structure, not meaning; model isolation is not an adversarial OS sandbox.

The [Claude-skills case study](evals/skill-categorizer-by-task/README.md) follows earlier high-level catalog analysis into finer task trials: the three-run quality gate **failed**, and a later authorized corpus run exposed substantial misbucketing. Neither completion nor low Other counts established quality.

The original 20-record flat task benchmark now has a [portable source-and-gold setup](evals/skill-categorizer-by-task/SETUP.md): Python stdlib fetches commit-pinned upstream files, checks hashes and reconstructs the exact inputs; project-authored gold is bundled unchanged. No corpus text or raw runs are redistributed, and setup makes no model calls. **A trie scorer is not implemented**; this is not a trie-quality benchmark.

Offline checks: `bun test` and `bun run typecheck`. Subprocess tests need Python 3 at `/usr/bin/python3` and on `PATH`, plus POSIX support (tested on Linux). These use synthetic fixtures, not live model calls; see [publication scope](docs/publication.md).

No license has been selected. Public visibility is not an open-source license grant; dependencies retain their own licenses.
