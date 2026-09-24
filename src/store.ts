import {createHash, randomUUID} from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return '{' + entries
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') + '}';
  }

  return JSON.stringify(value);
}

export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export interface CallEvidence {
  key: string;
  kind: string;
  request: unknown;
  started: string;
  response?: unknown;
  error?: string;
  finished?: string;
}

export interface Journal<T> {
  schema: 1;
  id: string;
  created: string;
  updated: string;
  snapshot: T;
  snapshotHash: string;
  calls: CallEvidence[];
  pins: Record<string, string>;
  data: Record<string, any>;
}

function snapshotIdentities(snapshot: unknown): Record<string, unknown> {
  const content = snapshot as Record<string, unknown>;
  const prompts = (content.prompts ?? {normalization: content.prompt ?? ''}) as Record<string, unknown>;

  return {
    inputHash: hash(content.inputs ?? null),
    configHash: hash(content.config ?? null),
    promptHashes: Object.fromEntries(
      Object.entries(prompts).map(([name, text]) => [name, hash(text)]),
    ),
  };
}

function createJournal<T>(snapshot: T): Journal<T> {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: randomUUID(),
    created: now,
    updated: now,
    snapshot,
    snapshotHash: hash(snapshot),
    calls: [],
    pins: {},
    data: {},
  };
}

export class Store<T> {
  private lockFd: number;

  constructor(readonly dir: string, readonly state: Journal<T>) {
    this.lockFd = openSync(join(dir, '.lock'), 'wx', 0o600);
    writeFileSync(this.lockFd, JSON.stringify({pid: process.pid, started: new Date().toISOString()}));
  }

  static create<T>(dir: string, snapshot: T): Store<T> {
    mkdirSync(dirname(dir), {recursive: true, mode: 0o700});
    mkdirSync(dir, {mode: 0o700});

    const store = new Store(dir, createJournal(snapshot));
    store.state.data.identities = snapshotIdentities(snapshot);
    store.save();
    return store;
  }

  static open<T>(dir: string): Store<T> {
    const state = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Journal<T>;
    if (state.schema !== 1 || hash(state.snapshot) !== state.snapshotHash) {
      throw Error('snapshot integrity mismatch');
    }
    return new Store(dir, state);
  }

  save(): void {
    this.state.updated = new Date().toISOString();
    const manifestPath = join(this.dir, 'manifest.json');
    const temporaryPath = manifestPath + '.tmp';
    const fileDescriptor = openSync(temporaryPath, 'w', 0o600);

    try {
      writeFileSync(fileDescriptor, JSON.stringify(this.state, null, 2) + '\n');
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }

    renameSync(temporaryPath, manifestPath);
    this.syncDirectory();
  }

  close(): void {
    closeSync(this.lockFd);
    unlinkSync(join(this.dir, '.lock'));
  }

  async call<R>(kind: string, request: unknown, maxCalls: number, fn: () => Promise<R>): Promise<R> {
    const key = hash({run: this.state.id, snapshot: this.state.snapshotHash, kind, request});
    const cached = this.state.calls.find(call => call.key === key && call.response !== undefined);
    if (cached) return cached.response as R;

    if (this.state.calls.length >= maxCalls) throw Error('call budget exhausted');

    const evidence: CallEvidence = {
      key,
      kind,
      request,
      started: new Date().toISOString(),
    };
    this.state.calls.push(evidence);
    this.save();

    try {
      const result = await fn();
      evidence.response = result;
      evidence.finished = new Date().toISOString();
      this.save();
      return result;
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : 'provider failure';
      evidence.finished = new Date().toISOString();
      this.save();
      throw error;
    }
  }

  private syncDirectory(): void {
    const directoryDescriptor = openSync(this.dir, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}
