#!/usr/bin/env bun
import {parseArgs} from 'node:util';
import {readFileSync, readdirSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedCategories, Config, Truth, records} from './contracts.ts';
import {Store, hash, type Journal} from './store.ts';
import {providers} from './providers.ts';
import {runWorkflow, type Snapshot} from './workflow.ts';
import {evaluate, makeEvalSnapshot, triplet, type EvalSnapshot} from './evaluation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

export function sourceHash() {
  const files = [
    'package.json',
    'bun.lock',
    ...readdirSync(join(root, 'src'))
      .filter(path => path.endsWith('.ts') || path.endsWith('.py'))
      .map(path => 'src/' + path),
    ...readdirSync(join(root, 'prompts')).map(path => 'prompts/' + path),
  ].sort();
  return hash(files.map(path => [path, readFileSync(join(root, path), 'utf8')]));
}

const help = `Bootstrap Categorizer (Bun)
trie help (broad-first hierarchical categorization; independent domain policy)
run --input records.jsonl|- --run-dir runs/new [--config config.json]
    [--categories categories.json | --categories-json '[{"id":"x","name":"...","description":"..."}]']
    [--seed-prompt file] [--curator-prompt file] [--reviewer-prompt file] [--judgment-prompt file]
    [--mode discovery|assessment] [--max-categories 100 (integer 1..253)] --allow-external
resume --run-dir runs/existing --allow-external
inspect --run-dir runs/existing
export --run-dir runs/existing --out new-directory
eval --run-dir runs/existing --truth truth.json --eval-dir runs/evaluation
     [--config judge-config.json] [--normalization-prompt file] --allow-external
eval-resume --eval-dir runs/evaluation --allow-external
triplet --eval-dirs eval-a,eval-b,eval-c [--out report.json]
Discovery is add-only roll-forward: no reviewer or final pass. maxRounds, review
and --reviewer-prompt are deprecated, accepted but ignored (including review:true).
No automatic acceptance trials or full-corpus expansion. Inputs leave this machine
only when --allow-external is supplied; auth comes from environment/selected backend.
`;

const options = {
  input: {type: 'string'},
  'run-dir': {type: 'string'},
  'eval-dir': {type: 'string'},
  'eval-dirs': {type: 'string'},
  config: {type: 'string'},
  categories: {type: 'string'},
  'categories-json': {type: 'string'},
  'seed-prompt': {type: 'string'},
  'curator-prompt': {type: 'string'},
  'reviewer-prompt': {type: 'string'},
  'judgment-prompt': {type: 'string'},
  'normalization-prompt': {type: 'string'},
  mode: {type: 'string'},
  'max-categories': {type: 'string'},
  truth: {type: 'string'},
  out: {type: 'string'},
  'allow-external': {type: 'boolean'},
} as const;

function load(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function manifest<T>(dir: string): Journal<T> {
  const result = load(join(dir, 'manifest.json'));
  if (result.schema !== 1 || hash(result.snapshot) !== result.snapshotHash) {
    throw Error('invalid snapshot');
  }
  return result;
}

function readPrompt(name: string, override?: string): string {
  return readFileSync(override ?? join(root, 'prompts', name + '.md'), 'utf8');
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === 'trie') {
    const {trieMain} = await import('./infrastructure/trie.ts');
    return trieMain(args.slice(1));
  }
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(help);
    return;
  }

  const {values} = parseArgs({args: args.slice(1), strict: true, options});
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value) throw Error(`--${key} required`);
    return value;
  };
  const requireConsent = () => {
    if (!values['allow-external']) {
      throw Error('--allow-external required: inputs/prompts are sent to external providers');
    }
  };
  if (
    values['max-categories'] !== undefined &&
    (command !== 'run' ||
      !/^\d+$/.test(values['max-categories']) ||
      Number(values['max-categories']) < 1 ||
      Number(values['max-categories']) > 253)
  ) {
    throw Error('--max-categories requires an integer 1..253 and is only valid for run');
  }

  const runCommand = async () => {
    requireConsent();
    const config = Config.parse({
      ...(values.config ? load(values.config) : {}),
      ...(values.mode ? {mode: values.mode} : {}),
      ...(values['max-categories'] !== undefined
        ? {maxCategories: Number(values['max-categories'])}
        : {}),
    });
    if (config.mode === 'discovery') {
      console.error('Discovery: maxRounds, review and reviewer-prompt are deprecated and ignored; no runtime reviewer or final pass.');
    }
    if (values.categories && values['categories-json']) {
      throw Error('choose one manual categories option');
    }

    const initial = values.categories
      ? boundedCategories(load(values.categories), config.maxCategories)
      : values['categories-json']
        ? boundedCategories(JSON.parse(values['categories-json']), config.maxCategories)
        : undefined;
    if (config.mode === 'assessment' && !initial) throw Error('assessment requires manual categories');

    const inputPath = required('input');
    const inputText = inputPath === '-' ? await Bun.stdin.text() : readFileSync(inputPath, 'utf8');
    const snapshot: Snapshot = {
      kind: 'workflow',
      inputs: records(inputText),
      initial,
      config,
      prompts: {
        seed: readPrompt('seed', values['seed-prompt']),
        curator: readPrompt('curator', values['curator-prompt']),
        reviewer: readPrompt('reviewer', values['reviewer-prompt']),
        judgment: readPrompt('judgment', values['judgment-prompt']),
      },
      sourceHash: sourceHash(),
      inputSource: inputPath === '-' ? 'stdin' : resolve(inputPath),
    };

    const provider = providers(config);
    if (config.mode === 'discovery') snapshot.curatorIdentity = provider.curatorIdentity?.();

    const store = Store.create(required('run-dir'), snapshot);
    try {
      await runWorkflow(store, provider);
      console.log(JSON.stringify({
        runId: store.state.id,
        status: store.state.data.status,
        stopReason: store.state.data.stopReason,
        calls: store.state.calls.length,
      }));
      if (store.state.data.status !== 'complete') process.exitCode = 2;
    } finally {
      store.close();
    }
  };

  const resumeCommand = async (evaluationResume: boolean) => {
    requireConsent();
    const store = Store.open<Snapshot | EvalSnapshot>(
      required(evaluationResume ? 'eval-dir' : 'run-dir'),
    );
    try {
      const snapshot = store.state.snapshot;
      if (snapshot.sourceHash !== sourceHash()) {
        throw Error('source changed since snapshot; restore frozen source before resume');
      }

      if (!evaluationResume && snapshot.kind === 'workflow') {
        await runWorkflow(store as Store<Snapshot>, providers(snapshot.config));
      } else if (evaluationResume && snapshot.kind === 'evaluation') {
        await evaluate(store as Store<EvalSnapshot>, providers(snapshot.config));
      } else {
        throw Error('wrong manifest kind');
      }

      console.log(JSON.stringify({status: store.state.data.status, calls: store.state.calls.length}));
      if (store.state.data.status !== 'complete') process.exitCode = 2;
    } finally {
      store.close();
    }
  };

  const inspectCommand = () => {
    const result = manifest<Snapshot | EvalSnapshot>(required('run-dir'));
    console.log(JSON.stringify({
      id: result.id,
      kind: result.snapshot.kind,
      snapshotHash: result.snapshotHash,
      pins: result.pins,
      calls: result.calls.length,
      status: result.data.status,
      stopReason: result.data.stopReason,
      error: result.data.error,
      metrics: result.data.metrics,
    }, null, 2));
  };

  const exportCommand = () => {
    const result = manifest<Snapshot>(required('run-dir'));
    if (result.snapshot.kind !== 'workflow') throw Error('workflow required');

    const output = required('out');
    mkdirSync(output, {mode: 0o700});
    const files = {
      manifest: result,
      taxonomies: result.data.taxonomies ?? [],
      assessments: result.data.assessments ?? [],
      assignments: Object.values(result.data.assignments ?? {}),
      unresolved: result.data.unresolved ?? [],
      decisions: result.data.decisions ?? [],
    };
    for (const [name, data] of Object.entries(files)) {
      writeFileSync(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
    }
    console.log(output);
  };

  const evaluateCommand = async () => {
    requireConsent();
    const run = manifest<Snapshot>(required('run-dir'));
    if (run.snapshot.kind !== 'workflow') throw Error('workflow required');

    const truth = Truth.parse(load(required('truth')));
    const config = Config.parse(
      values.config
        ? load(values.config)
        : {jevModel: run.pins.jev ?? run.snapshot.config.jevModel},
    );
    const snapshot = makeEvalSnapshot(
      run,
      truth,
      readPrompt('normalization', values['normalization-prompt']),
      config,
      sourceHash(),
    );
    const store = Store.create(required('eval-dir'), snapshot);
    try {
      await evaluate(store, providers(config));
      console.log(JSON.stringify(store.state.data.metrics, null, 2));
    } finally {
      store.close();
    }
  };

  const tripletCommand = () => {
    const result = triplet(required('eval-dirs').split(',').map(dir => manifest<EvalSnapshot>(dir)));
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.gate.pass) process.exitCode = 2;
  };

  switch (command) {
    case 'run':
      return runCommand();
    case 'resume':
      return resumeCommand(false);
    case 'eval-resume':
      return resumeCommand(true);
    case 'inspect':
      return inspectCommand();
    case 'export':
      return exportCommand();
    case 'eval':
      return evaluateCommand();
    case 'triplet':
      return tripletCommand();
    default:
      throw Error('unknown command; use help');
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'command failed');
    process.exitCode = 1;
  });
}
