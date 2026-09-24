import {curatorBackend, type CuratorBackend, type CuratorResult} from './curators.ts';
import type {Config, Request} from './contracts.ts';

export interface Providers {
  jev(req: Request): Promise<unknown>;
  curate(system: string, payload: unknown, sessionId?: string): Promise<CuratorResult>;
  curatorIdentity?: () => unknown;
}

function jevApiKey(): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw Error('TYPESAFE_API_KEY required');
  return key;
}

function jevRequest(config: Config, request: Request, apiKey: string): RequestInit {
  return {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  };
}

async function readJevResponse(response: Response, maxOutputBytes: number): Promise<unknown> {
  if (!response.ok) throw Error(`Jev HTTP ${response.status}`);
  if (!response.body) throw Error('Jev empty response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > maxOutputBytes) {
        await reader.cancel();
        throw Error('Jev output limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function requestJev(config: Config, request: Request): Promise<unknown> {
  const apiKey = jevApiKey();
  const response = await fetch(config.jevUrl, jevRequest(config, request, apiKey));
  return readJevResponse(response, config.maxOutputBytes);
}

export function providers(config: Config, adapter?: CuratorBackend): Providers {
  const curator = adapter ?? curatorBackend(config);

  return {
    jev: request => requestJev(config, request),
    curatorIdentity: curator.identity,
    curate: curator.curate,
  };
}
