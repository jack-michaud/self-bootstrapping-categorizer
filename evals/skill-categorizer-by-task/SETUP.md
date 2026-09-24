# Set up the original flat task benchmark

This reconstructs the **original 20 real-source records** and installs their **unchanged project-curated ground truth** (11 reference labels). It is not synthetic example data, a full-corpus downloader, or a new benchmark condition. No inference runs during setup.

**This is a flat primary-task evaluation. A trie scorer is not implemented.** Do not report this benchmark as trie routing/refinement quality, parent-child containment, broad semantic coverage, or a replay of the historical model results.

## Download and verify (no credentials or inference)

Requires Python 3.9+ standard library, HTTPS access to `raw.githubusercontent.com`, and a trusted checkout of this repository. No Python packages, GitHub token, Bun installation or model credentials are needed for setup. Run from the checkout root:

```sh
mkdir -p data
python3 -I -B scripts/setup_eval_data.py
python3 -I -B scripts/setup_eval_data.py --verify
```

Default output: `data/skill-categorizer-by-task-v1/` (Git-ignored). To choose a different location, create its parent first and pass `--output path/to/new-dataset` to both commands. Relative paths are relative to your working directory; the default is relative to the checkout. Downloaded data outside `data/` is your responsibility to keep out of Git.

The output is:

- `inputs.jsonl`: the exact original classifier input, including original whitespace and metadata.
- `ground-truth.json`: the exact original authored labels, item assignments and rationales.
- `sources/skill-NNN.md`: 20 hash-checked upstream files, stored as inert source evidence, **never installed, imported or executed**.
- `notices/`: eight pinned repository license files plus Caveman's pinned `LICENSING.md` scope explanation. These are provenance aids, not clearance of all imported components.
- `download-manifest.json`: the reviewed references, checksums, declarations and caveats shipped with this checkout. The original private `sources.json`, excerpts, catalog and run artifacts are not copied.

Setup makes 29 sequential bounded GETs from full 40-character commit URLs. Each request runs in a killable child with a **35-second total deadline**, a 10-second socket timeout and a **1 MiB body cap**. No retries, redirects, proxy-environment routing, moving-branch fallbacks, archives, credentials or downloaded code execution are used. HTTP failures, missing pinned files, malformed frontmatter or any hash mismatch stop setup; it never silently substitutes updated upstream data. Network availability is not guaranteed.

Files are fsynced in a private, same-filesystem staging directory and the complete validated directory is renamed into place. Handled failures remove the invocation's staging area and leave an existing dataset untouched. A cooperative per-destination lock rejects concurrent setup. Exact existing data is verified and reused **without network access**. Missing, extra, changed or symlinked files are refused, not repaired or overwritten; choose a new output path. There is intentionally no `--force` option.

After abrupt process death, an orphan `.NAME.stage-*` and `.NAME.setup-lock` can remain beside the destination. Confirm no owner is alive before moving those aside manually; they are never automatically adopted or deleted. Publication is process-atomic, not a power-loss durability or hostile same-user filesystem-race guarantee. Use an operator-controlled output parent; don't run setup concurrently with other programs mutating that directory. Symlink destinations/ancestors and unsafe manifest paths are rejected.

## Exact reconstruction and provenance

The original benchmark was curated before provider runs from a pinned skill catalog. The inputs contain only `id`, `text`, and `metadata:{repo,path,commit,url}`. `text` is the upstream frontmatter name, one newline, and its description; the original folded-scalar trailing newline is retained. IDs and order are unchanged. The stdlib parser deliberately supports only the scalar forms in these hash-pinned files (plain, continued plain, JSON-compatible double-quoted and folded `>`); it does **not** interpret arbitrary YAML tags, objects, aliases or executable directives.

Serialization is UTF-8, `json.dumps(record, ensure_ascii=False)` using default separators, followed by one newline per record. Complete source-body hashes are checked **before** extraction; the final serialized input hash must match the frozen original. There is no text patch, substitute record, generated answer or normalization to a different upstream version. Runtime `RecordSchema` subsequently trims text as it always has; this does not alter the reconstructed raw file.

| File | Frozen SHA-256 |
|---|---|
| `inputs.jsonl` | `af22f2743ea0c613a080e9f2988b643c0df67957ebc398ed17fa8473edc4e2e8` |
| `ground-truth.json` | `7b2496956ff16533fdb56756cab9ac03aaaca3d9b87e386dbf9bdd055075a964` |

The bundled gold is **project-authored curation**, not an upstream annotation dataset or universal ontology. Its definitions and rationales were based on source name/description plus targeted body checks. Only the initial primary task is scored; multifunction behavior and alternate reasonable granularity remain limitations. This benchmark has already informed experiments, so it is not held-out validation. Source texts are fetched directly from upstream rather than redistributed here; no historical private Git objects or experiment archives are required.

### License observations and distribution boundary

See [the manifest](download-manifest.json) for every exact source URL, body checksum and recorded component declaration. Public visibility and attribution alone are not permission to republish the downloaded dataset.

- Pinned root license texts for the eight selected distribution repositories were retrieved and observed to contain MIT grants, subject to their stated scope. Root grants do **not** establish rights for every imported component.
- Historical API metadata reported Caveman as `NOASSERTION`. At the actual pinned revision, `LICENSE` and `LICENSING.md` explicitly classify `skills/` as MIT and engine-linked runtime areas as BSL-1.1. Only three files under `skills/` are fetched; no engine code is used. This resolves the selected-path ambiguity without rewriting the historical API observation.
- Aggregated skills carry mixed or absent component declarations: for example, `verify-citations` declares Apache-2.0 despite the distribution repository's MIT root. Several imported skills have only attribution clues. The manifest preserves those declarations and moving upstream links as **unverified attribution**, never as download substitutes. No independent component chain-of-title/rights audit was performed.
- Bundled gold is the project's unchanged authored annotation, now included for this setup. No project license has been selected; this change does not create one. Dependencies and fetched material retain their applicable terms.
- Do not publish `inputs.jsonl`, `sources/`, downloaded notices as a purported license clearance package, or raw runs without a separate rights/privacy review. Full corpus/catalog, evidence quotations, distribution-description variants, private paths and raw model artifacts remain excluded from this source tree.

## Use the existing flat workflow and evaluator

These are **optional billable commands, not setup checks**. Install the pinned Bun dependencies and configure provider credentials as described in the [main README](../../README.md). Freeze your selected model versions, config, prompts and source identity before running. The example config uses a model alias and local curator runtime default; select explicitly available versions/runtime paths for your own new condition. Nothing here reproduces the old frozen runtime or promises the old scores.

Feed **only `inputs.jsonl`** to discovery. Do not expose gold, this guide, the provenance manifest or source evidence to the classifier/curator, and do not seed it with reference labels. The separate normalization judge sees only reference definitions and generated category definitions; item expectations/rationales are joined by deterministic scoring, not sent in its requests.

```sh
bun install --frozen-lockfile
# Prepare benchmark-config.json for your available, pinned providers/runtime.
cp examples/discovery-config.json benchmark-config.json
# Edit benchmark-config.json before proceeding. These commands incur provider calls:
bun src/cli.ts run --input data/skill-categorizer-by-task-v1/inputs.jsonl \
  --run-dir runs/task-benchmark-1 --config benchmark-config.json --allow-external
bun src/cli.ts eval --run-dir runs/task-benchmark-1 \
  --truth data/skill-categorizer-by-task-v1/ground-truth.json \
  --eval-dir runs/task-benchmark-1-eval --allow-external
```

For the historical *form* of the consistency gate, predeclare three fresh same-configuration runs using distinct `-1`, `-2`, `-3` run/eval directories; preserve all attempts and do not cherry-pick/retry semantic failures. Then aggregate the completed flat evaluations:

```sh
bun src/cli.ts triplet \
  --eval-dirs runs/task-benchmark-1-eval,runs/task-benchmark-2-eval,runs/task-benchmark-3-eval
```

The gate is at least 95% accuracy per run and 95% valid all-three normalized agreement, with all 20 items in the denominator. This small, previously inspected task set does not prove generalization, agent-task improvements or trie quality. See the [historical failures and semantic-judge caveats](README.md).

## Executed setup verification

The setup CLI was exercised against fresh public network downloads into an empty scratch destination, without credentials or provider inference. All **20 downloaded source bodies** matched the original benchmark's recorded hashes; reconstructed `inputs.jsonl` (**11,969 bytes**) and copied gold (**10,562 bytes**) compared **byte-for-byte equal** with the immutable original files and the hashes above. All nine notice files passed their pinned hashes. The actual Bun `RecordSchema` and `Truth` accepted 20 records / 11 labels / 20 assignments with exact ID joins. Original benchmark hashes, sizes and modification timestamps were unchanged.

Offline `--verify` reuse was also exercised. A second fresh network setup succeeded from a source-only three-file copy (script, manifest and gold), with only `PATH` and `TMPDIR` in its environment, no Git history, no `HOME` or credentials, and an unrelated working directory; both output files again matched the originals byte-for-byte.

Offline regressions use **newly authored synthetic source data**, not corpus excerpts. Run them directly or through the normal suite:

```sh
python3 -I -B tests/setup_eval_data_test.py -v
bun test
bun run typecheck
```

Tests cover exact serialization, gold/schema/source-ID validation, unsafe URLs/paths, duplicate notices, source/final hash mismatches, symlinks, missing/extra files, no-network reuse, preservation of changed datasets, partial-download failure, failed publication, locks and actual loopback HTTP status/redirect/encoding/size rejection. A real child-worker timeout checks total-deadline cancellation during slow headers. These are setup/software contracts, **not new model-quality evaluation runs**.
