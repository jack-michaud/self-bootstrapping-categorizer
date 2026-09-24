#!/usr/bin/env python3
"""Reconstruct the frozen flat benchmark; upstream files are inert data only."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "evals/skill-categorizer-by-task"
MAX_BYTES = 1_048_576
FETCH_SECONDS = 35
HEX = re.compile(r"[0-9a-f]{64}\Z")
URL = re.compile(r"https://raw\.githubusercontent\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[0-9a-f]{40}/[A-Za-z0-9_./-]+\Z")


class SetupError(Exception):
    pass


def require(ok, message):
    if not ok:
        raise SetupError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, expected, label):
    require(len(data) <= MAX_BYTES, f"{label}: exceeds {MAX_BYTES}-byte limit")
    require(digest(data) == expected, f"{label}: SHA-256 mismatch; upstream changed or bytes corrupted. No fallback to another revision.")
    return data


def safe_relative(value):
    require(isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_./-]+", value)), "invalid relative path")
    require(not value.startswith('/') and all(p not in ('', '.', '..') for p in value.split('/')), "unsafe relative path")
    return value


def validate_url(url):
    require(isinstance(url, str) and URL.fullmatch(url) is not None, "download requires an immutable raw.githubusercontent.com HTTPS URL")
    safe_relative(url.split('githubusercontent.com/', 1)[1])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SetupError("upstream redirect refused; review the pinned source, do not substitute another URL")


def fetch_worker(url):
    """Runs in a killable child so slow headers/DNS/body have a total deadline."""
    validate_url(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "frozen-eval-data-setup/1", "Accept-Encoding": "identity"})
    with opener.open(req, timeout=10) as response:
        require(response.status == 200, f"HTTP {response.status}")
        require(response.headers.get('Content-Encoding', 'identity') == 'identity', "compressed HTTP response refused")
        length = response.headers.get('Content-Length')
        if length is not None:
            require(length.isdigit() and int(length) <= MAX_BYTES, "invalid or oversized Content-Length")
        body = response.read(MAX_BYTES + 1)
        require(len(body) <= MAX_BYTES, "download exceeds byte limit")
        if length is not None:
            require(len(body) == int(length), "truncated HTTP response")
        return body


def fetch(url):
    validate_url(url)
    try:
        result = subprocess.run(
            [sys.executable, '-I', '-B', str(Path(__file__).resolve()), '_fetch', url],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=FETCH_SECONDS, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise SetupError(f"download exceeded {FETCH_SECONDS}s: {url}; retry setup in a new attempt") from error
    require(result.returncode == 0, f"download failed: {url}: {result.stderr.decode('utf-8', errors='replace').strip()[:500]}")
    require(len(result.stdout) <= MAX_BYTES, "download exceeds byte limit")
    return result.stdout


def frontmatter(data):
    """Only scalar forms in these hash-pinned files, NOT a general YAML parser.

    Never evaluates YAML tags, anchors, templates, shell, or skill instructions.
    Folded blocks preserve their final newline, as the original catalog did.
    """
    text = data.decode('utf-8')
    require(text.startswith('---\n') and '\n---\n' in text[4:], "missing frontmatter delimiters")
    lines = text[4:].split('\n---\n', 1)[0].split('\n')
    result = {}
    for index, line in enumerate(lines):
        match = re.fullmatch(r'(name|description): (.+)', line)
        if not match:
            continue
        key, scalar = match.groups()
        require(key not in result, f"duplicate frontmatter {key}")
        continuation = []
        for next_line in lines[index + 1:]:
            if not next_line.startswith(' '):
                break
            require(next_line.startswith('  ') and next_line[2:] and not next_line[2:].startswith((' ', '\t')), "unsupported scalar indentation")
            continuation.append(next_line[2:])
        if scalar == '>':
            require(bool(continuation), "empty folded scalar")
            value = ' '.join(continuation) + '\n'
        elif scalar.startswith('"'):
            require(not continuation, "unsupported quoted continuation")
            value = json.loads(scalar)
        else:
            require(not scalar.startswith(("'", '|', '>', '!', '&', '*', '[', '{')), "unsupported scalar form")
            value = ' '.join([scalar, *continuation])
        require(isinstance(value, str) and bool(value.strip()), f"invalid {key}")
        result[key] = value
    require(set(result) == {'name', 'description'}, "name and description required")
    return result


def load_bundle(bundle=BUNDLE):
    raw = (bundle / 'download-manifest.json').read_bytes()
    require(len(raw) <= MAX_BYTES, "manifest too large")
    manifest = json.loads(raw)
    require(manifest['schema_version'] == 1, "unsupported manifest version")
    items = manifest['items']
    require(len(items) == 20 and [i['id'] for i in items] == [f'skill-{n:03}' for n in range(1, 21)], "expected 20 ordered unique source IDs")
    outputs = {'inputs.jsonl', 'ground-truth.json', 'download-manifest.json'}
    for item in items:
        require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', item['repo']) is not None, "invalid repository")
        safe_relative(item['path'])
        require(re.fullmatch(r'[0-9a-f]{40}', item['commit']) is not None, "invalid commit")
        expected = f"https://github.com/{item['repo']}/blob/{item['commit']}/{item['path']}"
        require(item['url'] == expected, "source identity mismatch")
        require(HEX.fullmatch(item['sha256']) is not None, "invalid source hash")
        validate_url(raw_url(item))
        outputs.add(f"sources/{item['id']}.md")
    for notice in manifest['notices']:
        validate_url(notice['url'])
        path = safe_relative(notice['output'])
        require(path.startswith('notices/') and path not in outputs, "duplicate or unsafe notice output")
        require(HEX.fullmatch(notice['sha256']) is not None, "invalid notice hash")
        outputs.add(path)
    for key in ('inputs_sha256', 'truth_sha256'):
        require(HEX.fullmatch(manifest[key]) is not None, f"invalid {key}")
    truth_bytes = (bundle / 'ground-truth.json').read_bytes()
    checked(truth_bytes, manifest['truth_sha256'], 'bundled ground truth')
    validate_truth(json.loads(truth_bytes), [i['id'] for i in items])
    return manifest, raw, truth_bytes


def validate_truth(truth, ids):
    require(set(truth) == {'labels', 'items'}, "invalid truth keys")
    require(len(truth['labels']) == 11, "expected 11 reference labels")
    labels = []
    for label in truth['labels']:
        require(set(label) == {'id', 'name', 'description'}, "invalid label keys")
        require(all(isinstance(v, str) and v.strip() for v in label.values()), "invalid reference label")
        labels.append(label['id'])
    require(len(set(labels)) == len(labels), "duplicate labels")
    require([item['id'] for item in truth['items']] == ids, "truth/source IDs differ")
    for item in truth['items']:
        require(set(item) == {'id', 'label_id', 'rationale'}, "invalid truth item keys")
        require(item['label_id'] in labels and isinstance(item['rationale'], str) and item['rationale'].strip(), "invalid truth assignment")


def raw_url(item):
    return f"https://raw.githubusercontent.com/{item['repo']}/{item['commit']}/{item['path']}"


def reconstruct(manifest, bodies):
    records = []
    for item in manifest['items']:
        data = checked(bodies[item['id']], item['sha256'], item['id'])
        fields = frontmatter(data)
        text = fields['name'] + '\n' + fields['description']
        require(0 < len(text.strip()) <= 12000, "record text outside CLI schema bounds")
        records.append({'id': item['id'], 'text': text, 'metadata': {key: item[key] for key in ('repo', 'path', 'commit', 'url')}})
    encoded = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records).encode('utf-8')
    return checked(encoded, manifest['inputs_sha256'], 'reconstructed inputs.jsonl')


def expected_files(manifest, raw, truth):
    return {
        'download-manifest.json': digest(raw), 'ground-truth.json': digest(truth),
        'inputs.jsonl': manifest['inputs_sha256'],
        **{f"sources/{i['id']}.md": i['sha256'] for i in manifest['items']},
        **{n['output']: n['sha256'] for n in manifest['notices']},
    }


def safe_destination(path):
    # Refuse symlink ancestors rather than resolving them silently.
    path = Path(os.path.abspath(path))
    for component in [path, *path.parents]:
        require(not component.is_symlink(), f"symlink destination/ancestor refused: {component}")
    require(path.parent.is_dir(), "output parent must already exist; create it explicitly")
    return path


def verify_directory(path, expected):
    require(path.is_dir() and not path.is_symlink(), "output is not a regular dataset directory")
    found = set()
    for entry in path.rglob('*'):
        require(not entry.is_symlink(), f"symlink refused: {entry}")
        if entry.is_dir():
            require(entry.relative_to(path).as_posix() in {'sources', 'notices'}, "unexpected dataset directory")
            continue
        name = entry.relative_to(path).as_posix()
        require(name in expected and entry.is_file(), f"unexpected dataset file: {name}")
        require(entry.stat().st_size <= MAX_BYTES, f"oversized existing file: {name}")
        checked(entry.read_bytes(), expected[name], name)
        found.add(name)
    require(found == set(expected), "dataset incomplete; use a new output directory (existing data is never overwritten)")


def setup(output, *, bundle=BUNDLE, download=fetch, verify_only=False):
    manifest, raw, truth = load_bundle(bundle)
    expected = expected_files(manifest, raw, truth)
    output = safe_destination(output)
    lock = output.parent / ('.' + output.name + '.setup-lock')
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError as error:
        raise SetupError(f"setup lock exists: {lock}; check for another process. Never remove a live owner's lock.") from error
    stage = None
    try:
        if output.exists():
            try:
                verify_directory(output, expected)
            except SetupError as error:
                raise SetupError(f"{error}; refusing to overwrite {output}. Choose a new --output.") from error
            return 'verified existing dataset (no network)'
        require(not verify_only, "dataset does not exist; run setup without --verify")
        stage = Path(tempfile.mkdtemp(prefix='.' + output.name + '.stage-', dir=output.parent))
        (stage / 'sources').mkdir()
        (stage / 'notices').mkdir()
        bodies = {}
        def write(name, data):
            with (stage / name).open('xb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        for item in manifest['items']:
            data = checked(download(raw_url(item)), item['sha256'], item['id'])
            bodies[item['id']] = data
            write(f"sources/{item['id']}.md", data)
        for notice in manifest['notices']:
            write(notice['output'], checked(download(notice['url']), notice['sha256'], notice['output']))
        write('inputs.jsonl', reconstruct(manifest, bodies))
        write('ground-truth.json', truth)
        write('download-manifest.json', raw)
        verify_directory(stage, expected)
        require(not output.exists() and not output.is_symlink(), "output appeared during setup; refusing publication")
        stage.rename(output)  # Same-filesystem, complete-directory atomic publication.
        stage = None
        verify_directory(output, expected)
        return 'downloaded and verified 20 sources, 20 records and 11 gold labels'
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        lock.rmdir()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_fetch':
        sys.stdout.buffer.write(fetch_worker(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/skill-categorizer-by-task-v1', help='new dataset directory (parent must exist); mismatches are never overwritten')
    parser.add_argument('--verify', action='store_true', help='verify an existing complete dataset, without network access')
    args = parser.parse_args()
    print(setup(args.output, verify_only=args.verify))


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError, TypeError, http.client.HTTPException, urllib.error.URLError) as error:
        print(f"setup failed: {error}", file=sys.stderr)
        sys.exit(1)
