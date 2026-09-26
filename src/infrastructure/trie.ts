import {readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {Config, ProviderConfig, records, validateJev, type Request} from '../contracts.ts';
import {Store, hash, type Journal} from '../store.ts';
import {providers, type Providers} from '../providers.ts';
import {Policy, Definition} from '../domain/trie.ts';
import {prompts} from '../domain/prompts.ts';
import {initialState, runTrie, type Snapshot, type State, type Ports, type CuratorResponse} from '../application/trie.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const Settings = z.object({
  policy: Policy.default(Policy.parse({})),
  provider: ProviderConfig.default(ProviderConfig.parse({})),
  prompts: z.object({
    seed: z.string().min(1),
    curator: z.string().min(1),
    judgment: z.string().min(1),
  }).strict().partial().default({}),
}).strict();

function domainSourcePaths(directory = 'src/domain'): string[] {
  return readdirSync(join(root, directory), {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return domainSourcePaths(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

export function policySource() {
  const paths = [
    'package.json',
    'bun.lock',
    'src/contracts.ts',
    'src/cli.ts',
    'src/application/trie.ts',
    'src/infrastructure/trie.ts',
    'src/providers.ts',
    'src/curators.ts',
    'src/store.ts',
    ...domainSourcePaths(),
  ];
  return Object.fromEntries(
    paths.sort().map(path => [path, readFileSync(join(root, path), 'utf8')]),
  );
}

function checkSnapshot(manifest: Journal<Snapshot>): void {
  if (manifest.schema !== 1 || manifest.snapshot.kind !== 'trie' || hash(manifest.snapshot) !== manifest.snapshotHash) {
    throw Error('invalid trie snapshot');
  }
  if (hash({
    source: manifest.snapshot.policySource,
    policy: manifest.snapshot.policy,
    prompts: manifest.snapshot.prompts,
  }) !== manifest.snapshot.policyHash) {
    throw Error('policy snapshot integrity mismatch');
  }
}

export function readTrie(dir: string): Journal<Snapshot> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  checkSnapshot(manifest);
  return manifest;
}

async function judgeWithStore(
  store: Store<Snapshot>,
  provider: Providers,
  request: Request,
  maxCalls: number,
) {
  const pinnedRequest = {...request, model: store.state.pins.jev ?? request.model};
  const raw = await store.call('trie:jev', pinnedRequest, maxCalls, () => provider.jev(pinnedRequest));
  const result = validateJev(raw, pinnedRequest);

  if ((pinnedRequest.model !== 'jev-latest' && result.model !== pinnedRequest.model) || result.model.endsWith('latest')) {
    throw Error('Jev model identity mismatch');
  }

  if (!store.state.pins.jev) {
    store.state.pins.jev = result.model;
    const call = store.state.calls.at(-1)!;
    call.key = hash({
      run: store.state.id,
      snapshot: store.state.snapshotHash,
      kind: 'trie:jev',
      request: {...pinnedRequest, model: result.model},
    });
    store.save();
  }

  return result;
}

async function curateWithStore(
  store: Store<Snapshot>,
  provider: Providers,
  config: Config,
  phase: 'seed' | 'child',
  system: string,
  payload: unknown,
  maxCalls: number,
  sessionId?: string,
): Promise<CuratorResponse> {
  if (hash(provider.curatorIdentity?.() ?? null) !== hash(store.state.snapshot.curatorIdentity ?? null)) {
    throw Error('curator runtime identity changed');
  }

  const response = await store.call(
    'trie:' + phase,
    {system, payload, sessionId},
    maxCalls,
    () => provider.curate(system, payload, sessionId),
  );
  if (response.model !== config.curatorModel) throw Error('curator model identity mismatch');

  const stopReason = (response.raw as {stopReason?: string})?.stopReason;
  if (stopReason && stopReason !== 'stop') throw Error('curator did not finish');
  if (typeof response.text !== 'string' || Buffer.byteLength(response.text) > config.maxOutputBytes) {
    throw Error('curator output limit');
  }
  if (response.sessionId !== undefined && (typeof response.sessionId !== 'string' || !response.sessionId)) {
    throw Error('invalid curator session ID');
  }

  store.state.pins.curator = response.model;
  store.save();
  return {text: response.text, sessionId: response.sessionId};
}

export function triePorts(store: Store<Snapshot>, provider: Providers): Ports {
  const config = Config.parse(store.state.snapshot.config);
  return {
    save: () => store.save(),
    judge: (request, maxCalls) => judgeWithStore(store, provider, request, maxCalls),
    curate: (phase, system, payload, maxCalls, sessionId) =>
      curateWithStore(store, provider, config, phase, system, payload, maxCalls, sessionId),
  };
}

export const trieHelp = `Trie categorizer (separate from legacy flat mode)
trie run --input records.jsonl|- --run-dir runs/new [--config config.json]
         [--categories primary-definitions.json] --allow-external
trie resume --run-dir runs/existing --allow-external
trie inspect --run-dir runs/existing
trie export --run-dir runs/existing --out new-directory
Config: {policy: {...}, provider: {...}, prompts: {seed?,curator?,judgment?}}.
Manual primary definitions: [{name,description}], no IDs; code creates path IDs.
No external calls without consent. Blocked semantic/provider failures remain blocked;
resume continues interrupted work, not failed judgments. Create a fresh run after repair.
`;

type TrieArguments = {
  input?: string;
  'run-dir'?: string;
  config?: string;
  categories?: string;
  out?: string;
  'allow-external'?: boolean;
};

function parseTrieArguments(args: string[]): {values: TrieArguments} {
  return parseArgs({
    args,
    strict: true,
    options: {
      input: {type: 'string'},
      'run-dir': {type: 'string'},
      config: {type: 'string'},
      categories: {type: 'string'},
      out: {type: 'string'},
      'allow-external': {type: 'boolean'},
    },
  });
}

function requiredArgument(values: TrieArguments, key: 'run-dir' | 'input' | 'out'): string {
  const value = values[key];
  if (!value) throw Error(`--${key} required`);
  return value;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireExternalConsent(values: TrieArguments): void {
  if (!values['allow-external']) {
    throw Error('--allow-external required: inputs/prompts sent to external providers');
  }
}

function inspectTrie(manifest: Journal<Snapshot>, state: State): void {
  console.log(JSON.stringify({
    id: manifest.id,
    status: state?.status,
    stopReason: state?.stopReason,
    error: state?.error,
    calls: manifest.calls.length,
    completed: state?.cursor,
    policyHash: manifest.snapshot.policyHash,
  }, null, 2));
}

function exportTrie(manifest: Journal<Snapshot>, state: State, out: string): void {
  mkdirSync(out, {mode: 0o700});
  const assignments = state.progress.map(progress => ({
    ...progress,
    metadata: manifest.snapshot.inputs.find(record => record.id === progress.recordId)?.metadata,
  }));
  const files = {
    manifest,
    taxonomies: state.taxonomies,
    assignments,
    decisions: state.decisions,
  };

  for (const [name, value] of Object.entries(files)) {
    writeFileSync(
      join(out, name + '.json'),
      JSON.stringify(value, null, 2) + '\n',
      {mode: 0o600, flag: 'wx'},
    );
  }
  console.log(out);
}

async function createRunStore(
  values: TrieArguments,
  dir: string,
  factory: (config: Config) => Providers,
): Promise<{store: Store<Snapshot>; provider: Providers}> {
  const settings = Settings.parse(values.config ? loadJson(values.config) : {});
  const config = Config.parse(settings.provider);
  const input = requiredArgument(values, 'input');
  const raw = input === '-' ? await Bun.stdin.text() : readFileSync(input, 'utf8');
  const source = policySource();
  const frozenPrompts = {...prompts, ...settings.prompts};
  const snapshot: Snapshot = {
    kind: 'trie',
    inputs: records(raw),
    initial: values.categories ? z.array(Definition).min(1).parse(loadJson(values.categories)) : undefined,
    policy: settings.policy,
    prompts: frozenPrompts,
    policySource: source,
    policyHash: hash({source, policy: settings.policy, prompts: frozenPrompts}),
    inputSource: input === '-' ? 'stdin' : resolve(input),
    config,
  };

  const provider = factory(config);
  snapshot.curatorIdentity = provider.curatorIdentity?.();
  const store = Store.create(dir, snapshot);
  store.state.data.trie = initialState();
  store.save();
  return {store, provider};
}

function openResumeStore(
  values: TrieArguments,
  dir: string,
  factory: (config: Config) => Providers,
): {store: Store<Snapshot>; provider: Providers} {
  if (values.config || values.categories || values.input) {
    throw Error('resume uses frozen configuration and inputs');
  }

  const manifest = readTrie(dir);
  if (hash(manifest.snapshot.policySource) !== hash(policySource())) {
    throw Error('policy/source changed; restore frozen source or create a new run');
  }

  const provider = factory(Config.parse(manifest.snapshot.config));
  const store = Store.open<Snapshot>(dir);
  return {store, provider};
}

async function runStoredTrie(store: Store<Snapshot>, provider: Providers): Promise<void> {
  const state = store.state.data.trie as State;
  const config = Config.parse(store.state.snapshot.config);
  await runTrie(store.state.snapshot, state, triePorts(store, provider), config.jevModel);
  console.log(JSON.stringify({
    status: state.status,
    stopReason: state.stopReason,
    error: state.error,
    completed: state.cursor,
    calls: store.state.calls.length,
  }));
  if (state.status !== 'complete') process.exitCode = 2;
}

export async function trieMain(
  args: string[],
  factory: (config: Config) => Providers = providers,
): Promise<void> {
  const command = args[0];
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(trieHelp);
    return;
  }

  const {values} = parseTrieArguments(args.slice(1));
  const dir = requiredArgument(values, 'run-dir');

  if (command === 'inspect' || command === 'export') {
    const manifest = readTrie(dir);
    const state = manifest.data.trie as State;
    if (command === 'inspect') {
      inspectTrie(manifest, state);
    } else {
      exportTrie(manifest, state, requiredArgument(values, 'out'));
    }
    return;
  }

  if (command !== 'run' && command !== 'resume') throw Error('unknown trie command');
  requireExternalConsent(values);

  const {store, provider} = command === 'run'
    ? await createRunStore(values, dir, factory)
    : openResumeStore(values, dir, factory);

  try {
    await runStoredTrie(store, provider);
  } finally {
    store.close();
  }
}
