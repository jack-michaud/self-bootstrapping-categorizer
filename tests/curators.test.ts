import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {Config} from '../src/contracts.ts';
import {curatorBackend} from '../src/curators.ts';
import {providers} from '../src/providers.ts';

const config = Config.parse({});

test('Pi SDK is the only curator backend and is lazy-loaded', () => {
  expect(config.curatorBackend).toBe('pi');
  expect(() => Config.parse({curatorBackend: 'shell'})).toThrow();
  expect(curatorBackend(config).identity()).toMatchObject({
    backend: 'pi',
    adapter: 'pi-agent-session-v1',
    sdk: '0.78.1',
  });

  const source = readFileSync(new URL('../src/providers.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('pi-ai');
  expect(source).not.toContain('pi-coding-agent');
});

test('provider adapter forwards a Pi session ID and returns the updated session', async () => {
  let receivedSessionId: string | undefined;
  const adapter = {
    identity: () => ({adapter: 'fixture'}),
    async curate(_system: string, _payload: unknown, sessionId?: string) {
      receivedSessionId = sessionId;
      return {text: '{}', model: config.curatorModel, raw: {}, sessionId: 'pi-session-next'};
    },
  };
  const provider = providers({...config, curatorBackend: 'pi'}, adapter);
  const result = await provider.curate('SYSTEM', {fixture: true}, 'pi-session-prior');
  expect(receivedSessionId).toBe('pi-session-prior');
  expect(result.sessionId).toBe('pi-session-next');
});
