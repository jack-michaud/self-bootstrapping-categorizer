import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {Config} from './contracts.ts';
import {hash} from './store.ts';

export type CuratorConfig = Pick<
  Config,
  'curatorBackend' | 'curatorProvider' | 'curatorModel' | 'hermesRuntimePath' | 'timeoutMs' | 'maxTokens' | 'maxOutputBytes'
>;

export interface CuratorResult {
  text: string;
  model: string;
  raw: unknown;
}

export interface CuratorBackend {
  identity: () => unknown;
  curate: (system: string, payload: unknown) => Promise<CuratorResult>;
}

export const CHAT_LIMITATION = 'hermes-chat unavailable: installed CLI has no supported explicit empty-toolset contract (-t empty selects defaults; unknown toolsets are not a safety API). Use hermes-native for a fresh tool-free native completion with existing Hermes auth; no CLI fallback is attempted.';

const nativeScript = fileURLToPath(new URL('./hermes_native.py', import.meta.url));
const MAX_INPUT_BYTES = 2_000_000;

function runtimeRoot(config: CuratorConfig): string {
  return resolve(config.hermesRuntimePath ?? join(homedir(), '.hermes/hermes-agent'));
}

function runtimeHash(root: string): string {
  const files: string[] = [];
  const collectPythonFiles = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collectPythonFiles(path);
      } else if (entry.isFile() && path.endsWith('.py')) {
        files.push(path);
      }
    }
  };

  for (const directory of ['agent', 'hermes_cli']) collectPythonFiles(directory);
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    if (entry.isFile() && entry.name.endsWith('.py')) files.push(entry.name);
  }
  return hash(files.sort().map(path => [path, readFileSync(join(root, path), 'utf8')]));
}

export function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.env.HERMES_HOME) env.HERMES_HOME = process.env.HERMES_HOME;

  return {
    ...env,
    HERMES_SAFE_MODE: '1',
    HERMES_IGNORE_USER_CONFIG: '1',
    HERMES_IGNORE_RULES: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

type ProcessOptions = {timeoutMs: number; maxBytes: number; env?: NodeJS.ProcessEnv};

function killProcess(child: ReturnType<typeof spawn>, reason: string, setFailure: (reason: string) => void): void {
  setFailure(reason);
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
  }
}

function nativeFailureStage(output: string): string {
  try {
    const error = JSON.parse(output);
    if (error.error !== 'hermes_native_failure' || !['startup', 'request', 'auth', 'inference', 'validation'].includes(error.phase)) {
      return '';
    }

    let stage = ` at ${error.phase}`;
    const allowedCategories = [
      'AuthenticationError',
      'PermissionDeniedError',
      'BadRequestError',
      'NotFoundError',
      'RateLimitError',
      'APIConnectionError',
      'APITimeoutError',
      'AttributeError',
      'ValueError',
      'TypeError',
      'RuntimeError',
    ];
    if (allowedCategories.includes(error.category)) stage += ` (${error.category})`;
    return stage;
  } catch {
    return '';
  }
}

function runBoundedChild(
  command: string,
  args: string[],
  input: string,
  options: ProcessOptions,
  cwd: string,
): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? nativeEnvironment(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let outputBytes = 0;
    let failure: string | undefined;
    const output: Buffer[] = [];
    const setFailure = (reason: string): void => {
      failure ??= reason;
    };
    const consume = (data: Buffer, isStdout: boolean): void => {
      outputBytes += data.length;
      if (outputBytes > options.maxBytes) {
        killProcess(child, 'curator output exceeds byte limit', setFailure);
      } else if (isStdout) {
        output.push(data);
      }
    };

    const timer = setTimeout(
      () => killProcess(child, 'curator timeout', setFailure),
      options.timeoutMs,
    );
    child.stdout.on('data', data => consume(data, true));
    child.stderr.on('data', data => consume(data, false));
    child.stdin.on('error', () => {});
    child.on('error', () => setFailure('curator process unavailable'));
    child.on('close', code => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString('utf8');
      if (failure || code !== 0) {
        const stage = nativeFailureStage(text);
        rejectOutput(Error(failure ?? `curator subprocess failed${stage} (native auth/model/runtime; diagnostics suppressed)`));
        return;
      }
      resolveOutput(text);
    });
    child.stdin.end(input);
  });
}

export async function boundedProcess(
  command: string,
  args: string[],
  input: string,
  options: ProcessOptions,
): Promise<string> {
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw Error('curator input exceeds byte limit');
  const cwd = mkdtempSync(join(tmpdir(), 'categorizer-curator-'));
  try {
    return await runBoundedChild(command, args, input, options, cwd);
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
}

const NativeResult = z.object({
  protocol: z.literal(1),
  text: z.string().min(1),
  model: z.string().min(1),
  modelIdentity: z.enum(['response', 'requested']),
  stopReason: z.literal('stop'),
  usage: z.unknown(),
}).strict();

export function parseNativeResult(raw: string, maxBytes: number): CuratorResult {
  const result = NativeResult.parse(JSON.parse(raw));
  if (Buffer.byteLength(result.text) > maxBytes) throw Error('curator output exceeds byte limit');
  return {text: result.text, model: result.model, raw: result};
}

function backendIdentity(config: CuratorConfig): {backend: string; provider: string; model: string} {
  return {
    backend: config.curatorBackend,
    provider: config.curatorProvider,
    model: config.curatorModel,
  };
}

function hermesChatBackend(base: ReturnType<typeof backendIdentity>): CuratorBackend {
  return {
    identity: () => ({...base, adapter: 'hermes-chat-blocked-v1'}),
    curate: async () => {
      throw Error(CHAT_LIMITATION);
    },
  };
}

async function curateWithPi(
  config: CuratorConfig,
  system: string,
  payload: unknown,
): Promise<CuratorResult> {
  const [{completeSimple}, {AuthStorage, ModelRegistry}] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-coding-agent'),
  ]);
  const auth = AuthStorage.create();
  const registry = ModelRegistry.inMemory(auth);
  const model = registry.find(config.curatorProvider, config.curatorModel);
  if (!model) throw Error('Unknown Pi curator model/provider');

  const apiKey = await auth.getApiKey(config.curatorProvider, {includeFallback: false});
  if (!apiKey) throw Error('Configure curator authentication through Pi login');

  const result = await completeSimple(
    model,
    {
      systemPrompt: system,
      messages: [{role: 'user', content: JSON.stringify(payload), timestamp: Date.now()}],
      tools: [],
    },
    {
      apiKey,
      maxTokens: config.maxTokens,
      maxRetries: 0,
      transport: 'sse',
      reasoning: 'medium',
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (Buffer.byteLength(text) > config.maxOutputBytes) throw Error('curator output exceeds byte limit');
  return {text, model: result.model, raw: result};
}

function piBackend(config: CuratorConfig, base: ReturnType<typeof backendIdentity>): CuratorBackend {
  return {
    identity: () => ({...base, adapter: 'pi-complete-simple-v1', sdk: '0.78.1'}),
    curate: (system, payload) => curateWithPi(config, system, payload),
  };
}

function hermesNativeBackend(config: CuratorConfig, base: ReturnType<typeof backendIdentity>): CuratorBackend {
  const root = runtimeRoot(config);
  return {
    identity: () => ({
      ...base,
      adapter: 'hermes-native-v1',
      adapterHash: hash(readFileSync(nativeScript, 'utf8')),
      runtimeHash: runtimeHash(root),
      runtimePath: root,
    }),
    async curate(system, payload) {
      if (config.curatorProvider !== 'openai-codex') {
        throw Error('hermes-native currently supports only the verified openai-codex native client route');
      }
      const input = JSON.stringify({
        provider: config.curatorProvider,
        model: config.curatorModel,
        system,
        payload,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        maxOutputBytes: config.maxOutputBytes,
      });
      const raw = await boundedProcess(
        join(root, 'venv/bin/python'),
        ['-I', '-B', nativeScript, root],
        input,
        {timeoutMs: config.timeoutMs, maxBytes: config.maxOutputBytes * 2 + 4096},
      );
      return parseNativeResult(raw, config.maxOutputBytes);
    },
  };
}

export function curatorBackend(config: CuratorConfig): CuratorBackend {
  const base = backendIdentity(config);
  if (config.curatorBackend === 'hermes-chat') return hermesChatBackend(base);
  if (config.curatorBackend === 'pi') return piBackend(config, base);
  return hermesNativeBackend(config, base);
}
