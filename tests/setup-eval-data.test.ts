import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('portable eval setup: offline Python storage, schema and HTTP contracts', () => {
  const script = fileURLToPath(new URL('./setup_eval_data_test.py', import.meta.url));
  const result = spawnSync('python3', ['-I', '-B', script], {encoding: 'utf8', timeout: 30_000});
  expect({status: result.status, error: result.error?.message, stderr: result.stderr})
    .toMatchObject({status: 0, error: undefined});
}, 35_000);
