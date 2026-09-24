# Publication scope and verification

This repository begins with fresh publication history. It is a reviewed, standalone source export, not a mirror of the development repository or a redistribution of its corpus.

## Included

- Current TypeScript runtime and native Python curator adapter, unchanged from the source export.
- Default prompts, including the deprecated reviewer prompt required by the CLI's provenance snapshot. The discovery loop does not invoke it.
- Pinned Bun package metadata, lockfile and TypeScript configuration.
- The original seven Bun test files, subsequent trie/setup regression tests and a synthetic add-target fixture; synthetic example record, categories, truth and portable discovery configuration.
- This document, a general-purpose README, the design vision and a documentation-only [Claude-skills case study](../evals/skill-categorizer-by-task/README.md).
- A narrow visual exception: the original, unchanged aggregate `skill-atlas.png`, showing broad category counts and per-repository mixes, plus newly written prose, historical aggregate results and pinned public repository references. It contains no per-skill descriptions. The original interactive HTML, catalog JSON and source excerpts remain excluded.
- An additive [flat benchmark setup](../evals/skill-categorizer-by-task/SETUP.md): stdlib Python downloader, offline synthetic tests, a references/checksums/license-observations manifest, and unchanged **project-authored** ground truth (labels, assignments and rationales). Source texts are fetched directly from commit-pinned public upstreams into ignored local data, never copied into this repository. This is not a full-corpus export or trie scorer.

## Excluded

- All prior Git objects/history, full-corpus data, benchmark source texts, source catalogs and third-party copied skill artifacts.
- Run manifests, raw requests/responses, experiment logs, reports with private provenance, runtime/source freezes, local evaluation/verification directories, project-management files and demonstration artifacts.
- Credentials, machine-specific configuration/paths, dependency installations and generated exports.
- The historical Python experiment-launcher test and its private freeze/execution dependencies. This test concerns the excluded local experiment launcher, not the published CLI. There is no dangling import of it in the package test command.
- The historical two-call curator/reviewer smoke script and its package command. It is not the current add-only discovery workflow.

The original captured add-target failure fixture contained source-derived record/taxonomy material. The public fixture is newly authored synthetic data with the same relevant schema shape, a 16-category starting taxonomy and a nonempty string target. Its test is explicitly labeled synthetic rather than claiming to replay the original live response. Assertions still cover strict parsing, ignored-target journaling, raw-response preservation, cap/evidence/uniqueness enforcement and legacy validator rejection.

## Executed clean-export checks

On Linux with Bun 1.3.14 and Python 3, from this source-only export with a fresh dependency installation:

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed; 127 packages installed |
| `bun test` | 60 passed, 0 failed, 364 assertions across 7 files |
| `bun run typecheck` | Passed (`tsc --noEmit`) |
| `bun src/cli.ts help` | Passed |

The suite includes actual CLI subprocess/loopback HTTP checks for consent, fixed-taxonomy run, frozen resume, export, evaluation, malformed-response evidence and category limits; native subprocess protocol/isolation fixtures; roll-forward ordering and recovery-boundary tests; and normalization policy tests. These are offline software-contract checks, not fresh live-provider or model-quality validation. The private full-corpus run and benchmark were not rerun during publication.

The table above records the original clean-export checks, not the later trie/setup test totals. The case study's historical aggregate metrics are retained as limitations, not as bundled replayable experiment evidence. The additive setup was independently exercised against fresh network downloads: all 20 source hashes and both complete input/gold byte comparisons matched the original benchmark; details and commands are in the setup guide. Historical runtime/config freezes and raw private experiment material remain excluded. No license has been chosen or added.

The pinned Caveman license/scope files explicitly classify the selected `skills/` paths as MIT despite the historical API `NOASSERTION`; engine-linked areas are separately BSL-1.1 and are not fetched. Other repository MIT root notices do not establish rights for imported aggregator components, which include mixed/absent declarations. Those component rights remain a blocker to unreviewed **corpus redistribution**, not a reason to invent substitute inputs or silently change gold. The setup publishes only references and authored annotations, not those third-party source texts.
