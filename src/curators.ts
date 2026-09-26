import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {createAgentSession, SessionManager as PiSessionManager} from '@earendil-works/pi-coding-agent';
import type {Config} from './contracts.ts';

export type CuratorConfig = Pick<
  Config,
  'curatorBackend' | 'curatorProvider' | 'curatorModel' | 'timeoutMs' | 'maxTokens' | 'maxOutputBytes'
>;

export interface CuratorResult {
  text: string;
  model: string;
  raw: unknown;
  sessionId?: string;
}

export interface CuratorBackend {
  identity: () => unknown;
  curate: (system: string, payload: unknown, sessionId?: string) => Promise<CuratorResult>;
}

async function openPiSession(
  manager: typeof PiSessionManager,
  cwd: string,
  sessionId?: string,
): Promise<PiSessionManager> {
  if (!sessionId) return manager.create(cwd);
  const existing = (await manager.list(cwd)).find(session => session.id === sessionId);
  if (!existing) throw Error('Pi curator session not found');
  return manager.open(existing.path);
}

async function curateWithPi(
  config: CuratorConfig,
  system: string,
  payload: unknown,
  sessionId?: string,
): Promise<CuratorResult> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const {AuthStorage, ModelRegistry, SessionManager, createAgentSession} = sdk;
  const {DefaultResourceLoader} = sdk as typeof sdk & {
    DefaultResourceLoader: new(options: Record<string, unknown>) => NonNullable<Parameters<typeof createAgentSession>[0]>['resourceLoader'];
  };
  const auth = AuthStorage.create();
  const registry = ModelRegistry.inMemory(auth);
  const registeredModel = registry.find(config.curatorProvider, config.curatorModel);
  if (!registeredModel) throw Error('Unknown Pi curator model/provider');

  const apiKey = await auth.getApiKey(config.curatorProvider, {includeFallback: false});
  if (!apiKey) throw Error('Configure curator authentication through Pi login');

  const cwd = process.cwd();
  const agentDir = mkdtempSync(join(tmpdir(), 'categorizer-pi-agent-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const sessionManager = await openPiSession(SessionManager, cwd, sessionId);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: system,
    });
    const model = {...registeredModel, maxTokens: Math.min(registeredModel.maxTokens, config.maxTokens)};
    ({session} = await createAgentSession({
      cwd,
      agentDir,
      authStorage: auth,
      modelRegistry: registry,
      model,
      sessionManager,
      resourceLoader,
      noTools: 'all',
      tools: [],
    }));

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, config.timeoutMs);
    try {
      await session.prompt(JSON.stringify(payload), {source: 'extension'});
    } finally {
      clearTimeout(timeout);
    }
    if (timedOut) throw Error('curator timeout');

    const result = [...session.messages].reverse().find(message => message.role === 'assistant');
    if (!result || result.stopReason !== 'stop') throw Error('curator did not finish');
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (Buffer.byteLength(text) > config.maxOutputBytes) throw Error('curator output exceeds byte limit');
    return {text, model: result.model, raw: result, sessionId: session.sessionId};
  } finally {
    session?.dispose();
    rmSync(agentDir, {recursive: true, force: true});
  }
}

function piBackend(config: CuratorConfig, base: {backend: string; provider: string; model: string}): CuratorBackend {
  return {
    identity: () => ({...base, adapter: 'pi-agent-session-v1', sdk: '0.78.1'}),
    curate: (system, payload, sessionId) => curateWithPi(config, system, payload, sessionId),
  };
}

export function curatorBackend(config: CuratorConfig): CuratorBackend {
  const base = {
    backend: config.curatorBackend,
    provider: config.curatorProvider,
    model: config.curatorModel,
  };
  return piBackend(config, base);
}
