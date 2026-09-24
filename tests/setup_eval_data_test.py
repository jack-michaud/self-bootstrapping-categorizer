"""Offline downloader contracts. Every HTTP/source fixture below is newly authored."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('setup_eval_data', ROOT / 'scripts/setup_eval_data.py')
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def synthetic_bundle(root):
    bundle = root / 'bundle'
    bundle.mkdir()
    items, bodies, records = [], {}, []
    for n in range(1, 21):
        identity = f'skill-{n:03}'
        body = f'---\nname: fixture-{n}\ndescription: Synthetic fixture number {n}.\n---\nInert test data.\n'.encode()
        item = {'id': identity, 'repo': 'fixture/fixture', 'commit': 'a' * 40, 'path': f'skills/fixture-{n}/SKILL.md', 'sha256': m.digest(body)}
        item['url'] = f"https://github.com/{item['repo']}/blob/{item['commit']}/{item['path']}"
        items.append(item)
        bodies[m.raw_url(item)] = body
        records.append({'id': identity, 'text': f'fixture-{n}\nSynthetic fixture number {n}.', 'metadata': {k: item[k] for k in ('repo', 'path', 'commit', 'url')}})
    truth = {'labels': [{'id': f'label-{n}', 'name': f'Label {n}', 'description': 'Synthetic test label.'} for n in range(11)], 'items': [{'id': i['id'], 'label_id': f'label-{n % 11}', 'rationale': 'Synthetic assignment for storage testing only.'} for n, i in enumerate(items)]}
    gold = (json.dumps(truth, indent=2) + '\n').encode()
    inputs = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records).encode()
    notice_url = 'https://raw.githubusercontent.com/fixture/fixture/' + 'a' * 40 + '/LICENSE'
    bodies[notice_url] = b'Synthetic notice, not an actual license.\n'
    manifest = {'schema_version': 1, 'items': items, 'notices': [{'url': notice_url, 'sha256': m.digest(bodies[notice_url]), 'output': 'notices/fixture.txt'}], 'inputs_sha256': m.digest(inputs), 'truth_sha256': m.digest(gold)}
    (bundle / 'download-manifest.json').write_text(json.dumps(manifest))
    (bundle / 'ground-truth.json').write_bytes(gold)
    return bundle, manifest, bodies, inputs, gold


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle, self.manifest, self.bodies, self.inputs, self.gold = synthetic_bundle(self.root)
        self.output = self.root / 'dataset'

    def setup(self, **kwargs):
        return m.setup(self.output, bundle=self.bundle, download=self.bodies.__getitem__, **kwargs)

    def rewrite_manifest(self, manifest):
        (self.bundle / 'download-manifest.json').write_text(json.dumps(manifest))

    def test_complete_atomic_setup_exact_bytes_and_offline_reuse(self):
        def download(url):
            self.assertFalse(self.output.exists())
            return self.bodies[url]
        self.assertIn('20 sources', m.setup(self.output, bundle=self.bundle, download=download))
        self.assertEqual((self.output / 'inputs.jsonl').read_bytes(), self.inputs)
        self.assertEqual((self.output / 'ground-truth.json').read_bytes(), self.gold)
        with patch.object(m, 'fetch', side_effect=AssertionError('no network')):
            self.assertIn('no network', m.setup(self.output, bundle=self.bundle, download=lambda _: self.fail('network'), verify_only=True))
        self.assertFalse(list(self.root.glob('.dataset.*')))

    def test_mismatch_preserved_and_no_fetch(self):
        self.setup()
        sentinel = self.output / 'inputs.jsonl'
        sentinel.write_bytes(b'operator data')
        before = {p.relative_to(self.output): p.read_bytes() for p in self.output.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(m.SetupError, 'refusing to overwrite'):
            m.setup(self.output, bundle=self.bundle, download=lambda _: self.fail('network'))
        self.assertEqual(before, {p.relative_to(self.output): p.read_bytes() for p in self.output.rglob('*') if p.is_file()})

    def test_missing_extra_and_symlink_files_refused(self):
        self.setup()
        extra = self.output / 'extra'
        extra.write_text('operator file')
        with self.assertRaisesRegex(m.SetupError, 'unexpected dataset file'):
            self.setup()
        extra.unlink()
        source = self.output / 'sources/skill-001.md'
        saved = self.root / 'saved'
        source.rename(saved)
        with self.assertRaisesRegex(m.SetupError, 'incomplete'):
            self.setup()
        source.symlink_to(saved)
        with self.assertRaisesRegex(m.SetupError, 'symlink'):
            self.setup()

    def test_failure_after_partial_download_publishes_nothing(self):
        calls = []
        def download(url):
            calls.append(url)
            if len(calls) == 6:
                raise m.SetupError('simulated network outage')
            return self.bodies[url]
        with self.assertRaisesRegex(m.SetupError, 'network outage'):
            m.setup(self.output, bundle=self.bundle, download=download)
        self.assertEqual(len(calls), 6)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('.dataset.*')))
        self.setup()  # Fresh attempt succeeds, no poisoned partial cache.

    def test_hash_and_final_reconstruction_mismatch_fail_closed(self):
        url = next(iter(self.bodies))
        self.bodies[url] += b'changed'
        with self.assertRaisesRegex(m.SetupError, 'SHA-256 mismatch'):
            self.setup()
        self.assertFalse(self.output.exists())
        self.bodies[url] = self.bodies[url][:-7]
        self.manifest['inputs_sha256'] = '0' * 64
        self.rewrite_manifest(self.manifest)
        with self.assertRaisesRegex(m.SetupError, 'reconstructed inputs.jsonl'):
            self.setup()
        self.assertFalse(self.output.exists())

    def test_symlink_destination_parent_file_and_lock_refused(self):
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        self.output.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(m.SetupError, 'symlink'):
            self.setup()
        with self.assertRaisesRegex(m.SetupError, 'symlink'):
            m.setup(self.output / 'nested', bundle=self.bundle)
        self.output.unlink()
        self.output.write_text('retain')
        with self.assertRaisesRegex(m.SetupError, 'refusing to overwrite'):
            self.setup()
        self.assertEqual(self.output.read_text(), 'retain')
        self.output.unlink()
        lock = self.root / '.dataset.setup-lock'
        lock.mkdir()
        with self.assertRaisesRegex(m.SetupError, 'setup lock exists'):
            self.setup()
        self.assertTrue(lock.exists())

    def test_missing_parent_or_verify_missing_fails_before_network(self):
        with self.assertRaisesRegex(m.SetupError, 'parent must already exist'):
            m.setup(self.root / 'absent/dataset', bundle=self.bundle)
        with self.assertRaisesRegex(m.SetupError, 'does not exist'):
            self.setup(verify_only=True)
        self.assertFalse(self.output.exists())

    def test_corrupt_truth_schema_and_source_id_validation(self):
        (self.bundle / 'ground-truth.json').write_bytes(b'{}')
        with self.assertRaisesRegex(m.SetupError, 'ground truth'):
            self.setup()
        for change in ('labels', 'items'):
            truth = json.loads(self.gold)
            truth[change].append(truth[change][0])
            with self.assertRaises(m.SetupError):
                m.validate_truth(truth, [i['id'] for i in self.manifest['items']])
        (self.bundle / 'ground-truth.json').write_bytes(self.gold)
        self.manifest['items'][1]['id'] = 'skill-001'
        self.rewrite_manifest(self.manifest)
        with self.assertRaisesRegex(m.SetupError, 'unique source IDs'):
            self.setup()

    def test_unsafe_paths_refs_urls_and_notice_collisions(self):
        for bad in ('../out', '/out', 'notices/../out', 'notices//x', 'notices/./x', 'notices/x\\y'):
            with self.subTest(bad=bad), self.assertRaises(m.SetupError):
                m.safe_relative(bad)
        for bad in ('http://raw.githubusercontent.com/a/b/' + 'a' * 40 + '/x', 'https://example.com/a', 'https://raw.githubusercontent.com/a/b/main/x', 'https://raw.githubusercontent.com/a/b/' + 'a' * 40 + '/../x'):
            with self.subTest(bad=bad), self.assertRaises(m.SetupError):
                m.validate_url(bad)
        self.manifest['notices'].append(copy.deepcopy(self.manifest['notices'][0]))
        self.rewrite_manifest(self.manifest)
        with self.assertRaisesRegex(m.SetupError, 'duplicate or unsafe'):
            self.setup()

    def test_oversize_and_interrupted_publication(self):
        with self.assertRaisesRegex(m.SetupError, 'exceeds'):
            m.checked(b'x' * (m.MAX_BYTES + 1), '0' * 64, 'source')
        with patch.object(Path, 'rename', side_effect=OSError('disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                self.setup()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('.dataset.*')))

    def test_frontmatter_narrow_scalar_contract(self):
        for desc, expected in [('plain\n  continued', 'plain continued'), ('>\n  folded\n  scalar', 'folded scalar\n'), ('"Unicode \\u2192 data"', 'Unicode → data')]:
            body = f'---\nname: fixture\ndescription: {desc}\n---\nNever executed\n'.encode()
            self.assertEqual(m.frontmatter(body), {'name': 'fixture', 'description': expected})
        for desc in ('!python/object bad', '*alias', '|\n  unsupported', "'unsupported'", '>\n    wrong indent'):
            with self.assertRaises(m.SetupError):
                m.frontmatter(f'---\nname: fixture\ndescription: {desc}\n---\n'.encode())
        with self.assertRaisesRegex(m.SetupError, 'duplicate'):
            m.frontmatter(b'---\nname: x\nname: y\ndescription: data\n---\n')

    def test_real_bundle_gold_and_manifest_without_network(self):
        manifest, raw, gold = m.load_bundle()
        self.assertEqual(len(manifest['items']), 20)
        self.assertEqual(len(json.loads(gold)['labels']), 11)
        self.assertEqual(m.digest(gold), '7b2496956ff16533fdb56756cab9ac03aaaca3d9b87e386dbf9bdd055075a964')
        self.assertNotIn(b'/home/', raw)
        self.assertNotIn(b'evidence_quote', raw)
        self.assertNotIn(b'distribution_variants', raw)

    def test_cli_help_and_verify_missing(self):
        cli = [sys.executable, '-I', '-B', str(ROOT / 'scripts/setup_eval_data.py')]
        result = subprocess.run(cli + ['--help'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(cli + ['--verify', '--output', str(self.output)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('dataset does not exist', result.stderr)
        self.assertFalse(self.output.exists())


class HTTPTests(unittest.TestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass
            def do_GET(self):
                try:
                    if self.path == '/slow':
                        time.sleep(2)
                    if self.path == '/redirect':
                        self.send_response(302)
                        self.send_header('Location', '/ok')
                    elif self.path == '/missing':
                        self.send_response(404)
                    else:
                        self.send_response(200)
                    if self.path == '/oversized-header':
                        self.send_header('Content-Length', str(m.MAX_BYTES + 1))
                    if self.path == '/encoded':
                        self.send_header('Content-Encoding', 'gzip')
                    if self.path == '/truncated':
                        self.send_header('Content-Length', '100')
                    self.end_headers()
                    self.wfile.write(b'x' * (m.MAX_BYTES + 1) if self.path == '/oversized-body' else b'inert fixture')
                except (BrokenPipeError, ConnectionResetError):
                    pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def test_actual_http_transport_bounds_and_redirect_rejection(self):
        # Test-only bypass for loopback; production allows only pinned HTTPS GitHub URLs.
        with patch.object(m, 'validate_url', return_value=None):
            self.assertEqual(m.fetch_worker(self.url + '/ok'), b'inert fixture')
            for path in ('/redirect', '/missing', '/oversized-header', '/oversized-body', '/encoded', '/truncated'):
                with self.subTest(path=path), self.assertRaises((m.SetupError, m.urllib.error.HTTPError, m.http.client.HTTPException)):
                    m.fetch_worker(self.url + path)

    def test_total_deadline_kills_real_worker_during_slow_headers(self):
        real_run = subprocess.run
        def test_worker(argv, **kwargs):
            # Same worker implementation, with local-only URL injection in this test file.
            return real_run([sys.executable, '-I', '-B', __file__, '_worker', self.url + '/slow'], **kwargs)
        with patch.object(m, 'FETCH_SECONDS', 0.2), patch.object(m.subprocess, 'run', side_effect=test_worker):
            with self.assertRaisesRegex(m.SetupError, 'download exceeded'):
                m.fetch('https://raw.githubusercontent.com/fixture/fixture/' + 'a' * 40 + '/x')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '_worker':
        with patch.object(m, 'validate_url', return_value=None):
            sys.stdout.buffer.write(m.fetch_worker(sys.argv[2]))
    else:
        unittest.main()
