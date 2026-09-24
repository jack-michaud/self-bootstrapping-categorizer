# Trie categorizer implementation plan

> **For Hermes:** Execute task-by-task; parent independently reviews before any commit.

**Goal:** A bounded, resumable broad-first trie categorizer with human-owned pure rules.
**Architecture:** Domain models, decisions and prompt builders are pure TypeScript. Application interprets decisions through inference/checkpoint ports. Infrastructure reuses provider transport and atomic Store; an explicit trie CLI preserves flat compatibility.
**Tech Stack:** Bun, TypeScript, Zod; existing Jev and curator adapters.

1. Add failing `tests/trie.test.ts` for tree invariants, sibling routing and retention decisions; implement `src/domain/trie.ts` and `src/domain/prompts.ts`.
2. Implement `src/application/trie.ts`: frozen roots, per-parent once-only proposal/retry, immutable assignments and atomic retry checkpoint. Test no replay, budgets, invalid evidence and restart.
3. Compose `src/infrastructure/trie.ts` and CLI routing: source/policy snapshots, durable store, provider identity/pinning, inspect/export/resume. Test real CLI with injected local transports, without credentials or inference spend.
4. Add synthetic examples, `docs/domain-guide.md`, AGENTS ownership convention and README entrypoint.
5. Run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, help, and diff checks. No commits, push, paid inference or original-repository writes.

Acceptance: Other/Unclear roots never grow; only supported specific uncovered child triggers curator; no empty Choice; existing definitions immutable; evidence and cleanup preserved on errors; retry checkpoint includes taxonomy; completed records never replay; changed policy rejects resume but read/export remain frozen. Structural checks do not prove semantic containment.
