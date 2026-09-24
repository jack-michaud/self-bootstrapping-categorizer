import {
  children,
  decide,
  depthStop,
  resolveRefinement,
  growthLimit,
  pathTo,
  freezeRoots,
  cleanProposal,
  validateProposal,
  type Policy,
  type Taxonomy,
  type Node,
  type RecordInput,
  type Definition,
} from '../domain/trie.ts';
import {judgmentRequest, curatorPayload, type Prompts} from '../domain/prompts.ts';
import {Choice, Noul, type Request, type JevResult} from '../contracts.ts';

export interface Snapshot {
  kind: 'trie';
  inputs: RecordInput[];
  initial?: Definition[];
  policy: Policy;
  prompts: Prompts;
  policySource: Record<string, string>;
  policyHash: string;
  inputSource: string;
  config: unknown;
  curatorIdentity?: unknown;
}

export interface Step {
  parentId: string | null;
  taxonomyVersion: number;
  path: Node[];
  choice: string;
  judgment: JevResult;
}

export interface Progress {
  recordId: string;
  parentId: string | null;
  stage: 'judge' | 'curate' | 'retry' | 'done';
  path: Node[];
  steps: Step[];
  attemptedParents: string[];
  terminalReason?: string;
}

export interface CleanupAudit {
  actionIndex: number;
  originalTarget: string;
  phase: string;
  parentId: string | null;
  taxonomyVersion: number;
  recordIds: string[];
}

export interface State {
  status: 'running' | 'complete' | 'limited' | 'blocked';
  error?: string;
  stopReason?: string;
  cursor: number;
  taxonomies: Taxonomy[];
  progress: Progress[];
  decisions: unknown[];
  ignoredAddTargets: CleanupAudit[];
  limited: boolean;
}

export interface Ports {
  save(): void;
  judge(request: Request, maxCalls: number): Promise<JevResult>;
  curate(phase: 'seed' | 'child', system: string, payload: unknown, maxCalls: number): Promise<string>;
}

export const initialState = (): State => ({
  status: 'running',
  cursor: 0,
  taxonomies: [],
  progress: [],
  decisions: [],
  ignoredAddTargets: [],
  limited: false,
});

function finishRecord(state: State, progress: Progress, reason: string, ports: Ports): void {
  progress.stage = 'done';
  progress.terminalReason = reason;
  state.cursor++;
  ports.save();
}

async function requestDefinitions(
  snapshot: Snapshot,
  state: State,
  ports: Ports,
  phase: 'seed' | 'child',
  taxonomy: Taxonomy | undefined,
  parentId: string | null,
  records: RecordInput[],
  judgment?: unknown,
): Promise<Definition[]> {
  const system = snapshot.prompts[phase === 'seed' ? 'seed' : 'curator'];
  const payload = curatorPayload(taxonomy, parentId, records, snapshot.policy, judgment);
  const raw = await ports.curate(phase, system, payload, snapshot.policy.maxCalls);
  const cleaned = cleanProposal(JSON.parse(raw));
  const recordIds = records.map(record => record.id);

  for (const target of cleaned.ignoredAddTargets) {
    const audit: CleanupAudit = {
      ...target,
      phase,
      parentId,
      taxonomyVersion: taxonomy?.version ?? 0,
      recordIds,
    };
    if (!state.ignoredAddTargets.some(previous => JSON.stringify(previous) === JSON.stringify(audit))) {
      state.ignoredAddTargets.push(audit);
    }
  }
  ports.save();

  const definitions = validateProposal(cleaned.proposal, parentId, recordIds);
  state.decisions.push({
    phase,
    parentId,
    taxonomyVersion: taxonomy?.version ?? 0,
    proposal: cleaned.proposal,
  });
  return definitions;
}

async function initializeTaxonomy(
  snapshot: Snapshot,
  state: State,
  ports: Ports,
): Promise<void> {
  if (state.taxonomies.length) return;
  const definitions = snapshot.initial ?? await requestDefinitions(
    snapshot,
    state,
    ports,
    'seed',
    undefined,
    null,
    snapshot.inputs.slice(0, snapshot.policy.seedSize),
  );
  state.taxonomies.push(freezeRoots(definitions, snapshot.policy));
  ports.save();
}

async function handleCuration(
  snapshot: Snapshot,
  state: State,
  progress: Progress,
  record: RecordInput,
  taxonomy: Taxonomy,
  ports: Ports,
): Promise<void> {
  const parentId = progress.parentId;
  if (parentId === null) throw Error('frozen roots');

  const limit = growthLimit(taxonomy, parentId, snapshot.policy);
  if (limit) {
    state.limited = true;
    finishRecord(state, progress, limit, ports);
    return;
  }

  const definitions = await requestDefinitions(
    snapshot,
    state,
    ports,
    'child',
    taxonomy,
    parentId,
    [record],
    progress.steps.at(-1)?.judgment,
  );
  const refinement = resolveRefinement(taxonomy, parentId, definitions, snapshot.policy);
  if (refinement.kind === 'retain') {
    finishRecord(state, progress, refinement.reason, ports);
    return;
  }

  state.taxonomies.push(refinement.taxonomy);
  progress.stage = 'retry';
  ports.save();
}

async function handleJudgment(
  snapshot: Snapshot,
  state: State,
  progress: Progress,
  record: RecordInput,
  taxonomy: Taxonomy,
  model: string,
  ports: Ports,
): Promise<void> {
  const request = judgmentRequest(taxonomy, progress.parentId, record, model, snapshot.prompts.judgment);
  const result = await ports.judge(request, snapshot.policy.maxCalls);
  const choice = Choice.parse(result.answers.branch).choice;
  const selectedNode = children(taxonomy, progress.parentId).find(node => node.id === choice);
  const path = pathTo(taxonomy, selectedNode?.id ?? progress.parentId);

  progress.steps.push({
    parentId: progress.parentId,
    taxonomyVersion: taxonomy.version,
    path,
    choice,
    judgment: result,
  });

  const support = progress.parentId !== null ? Noul.parse(result.answers.feasible).noul : 1;
  const decision = decide(
    choice,
    progress.parentId,
    progress.stage === 'retry',
    progress.path.length,
    snapshot.policy,
    support,
  );

  if (decision.kind === 'descend') {
    const node = children(taxonomy, progress.parentId).find(candidate => candidate.id === decision.id);
    if (!node) throw Error('not a sibling');
    progress.path = [...progress.path, node];
    progress.parentId = node.id;
    progress.stage = 'judge';
    ports.save();
    return;
  }

  if (decision.kind === 'terminal') {
    finishRecord(state, progress, decision.reason, ports);
    return;
  }

  if (progress.parentId === null || progress.attemptedParents.includes(progress.parentId)) {
    throw Error('proposal attempt invariant');
  }
  progress.attemptedParents.push(progress.parentId);
  progress.stage = 'curate';
  ports.save();
}

export async function runTrie(snapshot: Snapshot, state: State, ports: Ports, model: string): Promise<void> {
  if (state.status === 'complete' || (state.status === 'limited' && state.cursor === snapshot.inputs.length)) return;
  if (state.status === 'blocked') return;

  state.status = 'running';
  delete state.error;
  delete state.stopReason;

  try {
    await initializeTaxonomy(snapshot, state, ports);

    while (state.cursor < snapshot.inputs.length) {
      const record = snapshot.inputs[state.cursor]!;
      let progress = state.progress[state.cursor];
      if (!progress) {
        progress = {
          recordId: record.id,
          parentId: null,
          stage: 'judge',
          path: [],
          steps: [],
          attemptedParents: [],
        };
        state.progress.push(progress);
        ports.save();
      }

      const taxonomy = state.taxonomies.at(-1)!;
      if (progress.stage === 'done') throw Error('cursor/progress invariant');

      const stop = depthStop(progress.path.length, snapshot.policy);
      if (stop) {
        finishRecord(state, progress, stop.reason, ports);
        continue;
      }

      if (progress.stage === 'curate') {
        await handleCuration(snapshot, state, progress, record, taxonomy, ports);
        continue;
      }

      await handleJudgment(snapshot, state, progress, record, taxonomy, model, ports);
    }

    state.status = state.limited ? 'limited' : 'complete';
    state.stopReason = state.limited ? 'category_limit' : 'inputs_exhausted';
    ports.save();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = state.error === 'call budget exhausted' ? 'limited' : 'blocked';
    state.stopReason = state.status === 'limited' ? 'call_limit' : 'failure';
    const current = state.progress[state.cursor];
    if (current) current.terminalReason = state.stopReason;
    ports.save();
  }
}
