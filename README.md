# Self-Bootstrapping Categorizer

A standalone Bun/TypeScript CLI and small library for discovering task categories in text records. A tool-free curator proposes categories; TypeSafe Jev supplies independent typed judgments; code owns validation, budgets, checkpoints and evaluation. This is an experimental categorizer, **not a validated high-accuracy classifier**.

## Install and test

Requires **Bun 1.3.14**. The offline subprocess tests also require Python 3 at `/usr/bin/python3` and POSIX process/symlink support (tested on Linux).

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun src/cli.ts help
```

Dependencies are pinned in `package.json` and `bun.lock`; package-registry publication is disabled with `private: true`. Tests use synthetic records, injected providers, loopback HTTP and a synthetic Python runtime. They do not require provider credentials or make live model calls. See [publication scope](docs/publication.md) for test coverage and excluded private experiments.

## Roll-forward discovery

1. Generate at most `min(10, maxCategories)` initial categories from a bounded hash-selected sample, or provide manual initial categories. The default total ceiling is 100; `maxCategories` must be an integer from 1 to 253. These are ceilings, not quotas.
2. Classify each record in input order. Preserve independent broad-domain and primary-task Choices, one membership Noul per known task, and an uncovered-task Noul. Tasks are not domain-prefiltered. Low membership Noul means likely nonmembership, not uncertainty.
3. A primary **Other** immediately sends the current record, its judgment and the current taxonomy to the curator. Other is a discovery signal, not proof that a new category is justified. **Unclear** denotes insufficient evidence or no unique primary task and does not trigger category creation.
4. Strictly parse the entire JSON proposal and validate add-only actions, evidence, unique names/IDs, reserved names and the resulting category count. Existing category IDs and definitions are immutable. No runtime model reviewer runs.
5. In this add-only workflow, a nonempty string `target` is meaningless because code generates the ID: clear it **only after strict schema parsing**, and journal the original target and zero-based action index in `ignoredAddTargets`. Raw provider responses remain preserved. Missing/non-string targets, nonempty sources, invalid evidence and non-add actions still fail. The legacy `applyProposal` library utility remains strict and does not perform this cleanup.
6. Atomically checkpoint accepted additions with retry intent, then retry **only the triggering record once**. An empty proposal or a still-Other retry advances to the next record. Never revisit earlier assignments and never run a final consistency sweep.

Each assignment retains the taxonomy version it actually saw. Completion means input exhaustion, not ontology convergence. At the category ceiling, an Other record skips curator dispatch and processing continues within the call budget; terminal status is `limited` / `category_limit`. `maxCalls` counts persisted attempts, including failures. `maxRounds`, `review` and `--reviewer-prompt` are deprecated compatibility/provenance fields and do not enable runtime review or rounds.

## Inputs and use

Input is JSONL: one `{id,text,metadata?}` object per line. IDs must be unique; text must be nonempty and at most 12,000 characters. Unknown top-level fields are rejected. Metadata is optional JSON; the CLI does not dereference its paths/URLs or execute record instructions. Never include evaluation answers in classifier inputs.

```json
{"id":"document-1","text":"Draft an explanatory essay from a topic and outline."}
```

Manual categories are arrays of `{id,name,description}` with unique IDs/names and explicit scope/exclusions. They can exceed the generated seed ceiling, but must fit the total ceiling. Examples in this repository are synthetic.

Set `TYPESAFE_API_KEY` in the calling environment through your credential manager. Do not place secrets in JSON config, command arguments or Git. **`--allow-external` permits sending input text, metadata and prompts to external providers and may incur charges.**

```sh
# Fixed taxonomy: Jev only; no curator runtime/auth needed.
bun src/cli.ts run --input examples/records.jsonl --run-dir runs/assessment \
  --categories examples/categories.json --mode assessment --allow-external

# Self-bootstrap: configure an available curator model and backend first.
bun src/cli.ts run --input examples/records.jsonl --run-dir runs/discovery \
  --config examples/discovery-config.json --max-categories 100 --allow-external

bun src/cli.ts inspect --run-dir runs/discovery
bun src/cli.ts resume --run-dir runs/discovery --allow-external
mkdir -p exports
bun src/cli.ts export --run-dir runs/discovery --out exports/discovery
```

Run directories must be new for `run`; `export` requires a new output directory and an existing parent (for the example, first `mkdir -p exports`). `--input -` accepts stdin. Manual categories in discovery skip seed generation but still allow immediate Other-triggered additions. Customize `--seed-prompt`, `--curator-prompt` and `--judgment-prompt` as needed.

Snapshots bind input, config, prompts, source and adapter/runtime identities. Successful identical calls are cached within the run; failures consume budget and stop with durable evidence. `resume` checks the frozen source and uses the saved configuration. Source changes require a new run or restoring the original source; this export is not a migration tool for private historical runs. After an abnormal exit a stale `.lock` may require operator reconciliation: do not remove it unless the owning process is confirmed dead. There is no exactly-once provider billing guarantee.

Run manifests and exports contain original text, metadata, raw model responses and local provenance paths. Treat them as sensitive; review before sharing and keep them outside Git.

## Providers and configuration

`--config` accepts strict JSON. The [example](examples/discovery-config.json) selects `hermes-native` / `openai-codex` / `gpt-6-astra`; model availability depends on your account, and the example is not an availability guarantee. The underlying default curator model remains `gpt-5.4`; explicitly select an available model.

- **`hermes-native` (default):** requires a separately installed, trusted Hermes Python runtime and its existing authentication. Default runtime root: `~/.hermes/hermes-agent`, with `venv/bin/python`; override `hermesRuntimePath` for another installation. The adapter requires the native `resolve_provider_client(..., raw_codex=True)` interface and currently supports only `openai-codex`. Each call uses a fresh subprocess, empty temporary cwd, environment allowlist, direct Responses request, `tools: []`, `store: false`, and zero inference retries. It does not instantiate a persistent agent/session or load skills/memory into model context. Runtime/API compatibility can change.
- **`pi`:** uses the pinned SDK with fresh one-message context, `tools: []` and existing Pi authentication. Configure a supported provider/model and authenticate separately. Pi imports and auth are not loaded when Hermes is selected.
- **`hermes-chat`:** deliberately fail-closed; the adapter does not rely on unsupported CLI empty-toolset tricks or silently fall back to chat.

Useful defaults: `jevModel: "jev-latest"`, `maxCalls: 200`, `sampleSize: 40`, `timeoutMs: 120000`, `maxOutputBytes: 262144`, `maxTokens: 8000`, `mode: "discovery"`. Prefer a versioned Jev model for reproducible experiments; an explicit version must match the first response, while an explicitly selected alias resolves and pins once. All later calls reject model drift. Consult [the strict config schema](src/contracts.ts) for every field and bound.

Native calls have wall-clock, stream-byte and final-output-byte bounds; `maxTokens` applies to Pi only, **not the native Codex endpoint**. These controls are not a token/billing guarantee or an adversarial OS sandbox. Jev uses `https://api.typesafe.ai/v1/systemone` by default. A custom `jevUrl` receives your TypeSafe key; use only trusted endpoints. Redirects are refused.

Library entrypoints live in `src/contracts.ts`, `src/workflow.ts`, `src/evaluation.ts`, `src/store.ts` and `src/providers.ts`. Provider implementations are injectable trusted application code, not plugins selected by input records.

## Evaluation and known limitations

A separate Jev normalization judge maps generated category definitions to supplied reference labels; expected per-record labels/rationales do not enter classifier, curator or normalization-judge requests. Normalization requires the selected option's `probabilities[choice] >= 0.95` by default, not its separate confidence field. Abstentions remain in the accuracy denominator and do not earn invalid-label agreement. Membership Nouls use separate policies.

```sh
bun src/cli.ts eval --run-dir runs/assessment --truth examples/truth.json \
  --eval-dir runs/assessment-eval --allow-external
# For three fresh, same-configuration bootstrap runs and their completed evaluations:
# bun src/cli.ts triplet --eval-dirs runs/eval-a,runs/eval-b,runs/eval-c
```

The triplet gate requires at least 95% accuracy in each run and at least 95% valid all-three agreement. Mixed-version assignments are scored only when the selected category existed at the recorded version with the same definition. Automated normalization is not independent human validation; broad categories can hide task conflation.

**Historical observations, not rerun publication tests:**

- The prior roll-forward benchmark scored **90%, 100%, 100% accuracy and 90% all-three agreement: FAIL**. Subsequent full-corpus execution was explicitly authorized despite that failed gate; it does not retroactively pass the benchmark.
- The later full-corpus roll-forward-v2 run completed **2,664 records**, with **2,141 known-category assignments, 521 Unclear, 2 Other, 73 categories and 2,783 provider calls**. Review identified **1,716 records misbucketed into “Command and capability reference.”** Processing completion is therefore **not categorization-quality success**, and this repository makes no broad accuracy claim.
- Prompt/threshold work informed by benchmark inspection is not held-out validation. Input order, seed sampling, taxonomy granularity and immutable early assignments can materially affect outcomes. A low Other count alone does not demonstrate a useful taxonomy.

Private corpus, benchmark source material and raw experiment evidence are intentionally not redistributed. These historical aggregate observations cannot be independently reproduced from this source-only export alone. Publication verification exercises software contracts, not live model quality.

No license has been selected or added. Public visibility is not a grant of an open-source license; separately installed dependencies retain their own licenses.
