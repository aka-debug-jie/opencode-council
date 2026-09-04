#!/usr/bin/env python3
"""Download public paper copies for local evaluation, not redistribution."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent / 'tasks' / 'paper-coordination'
PAPERS = [
    ('spanner', "Spanner: Google's Globally-Distributed Database", 'https://research.google.com/archive/spanner-osdi2012.pdf'),
    ('calvin', 'Calvin: Fast Distributed Transactions for Partitioned Database Systems', 'https://www.cs.umd.edu/~abadi/papers/calvin-sigmod12.pdf'),
    ('coordination', 'Coordination Avoidance in Database Systems', 'https://www.vldb.org/pvldb/vol8/p185-bailis.pdf'),
]

def main():
    directory = ROOT / 'papers'
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / 'sources.json'
    prior = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    records = []
    for identifier, title, url in PAPERS:
        pdf = directory / (identifier + '.pdf')
        if not pdf.exists():
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            if not data.startswith(b'%PDF-'):
                raise ValueError('Not a PDF: ' + url)
            pdf.write_bytes(data)
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if prior:
            expected = next(p for p in prior['papers'] if p['id'] == identifier)
            if expected['pdf_sha256'] != sha:
                raise ValueError('Source changed; review before replacing frozen paper: ' + identifier)
        text = directory / (identifier + '.txt')
        subprocess.run(['pdftotext', '-layout', str(pdf), str(text)], check=True)
        text_sha = hashlib.sha256(text.read_bytes()).hexdigest()
        if prior and expected['text_sha256'] != text_sha:
            raise ValueError('Extraction changed; review before replacing frozen text: ' + identifier)
        endpoint = 'https://api.crossref.org/works?' + urllib.parse.urlencode({'query.bibliographic': title, 'rows': 1})
        metadata = directory / (identifier + '.crossref.json')
        if not metadata.exists():
            with urllib.request.urlopen(endpoint, timeout=60) as response:
                metadata.write_bytes(response.read())
        # Raw discovery metadata is retained for review, not treated as a full-text license.
        records.append(dict(id=identifier, title=title, url=url, pdf_sha256=sha,
                            text_sha256=text_sha, metadata_endpoint=endpoint,
                            local_text='papers/' + text.name))
    if prior is None:
        manifest_path.write_text(json.dumps({'status':'source-verified-rubric-awaits-human-review', 'papers':records}, indent=2) + '\n')
    print('Verified 3 local paper PDFs and extracted texts; no model calls. Raw Crossref JSON is in papers/.')

if __name__ == '__main__':
    main()
