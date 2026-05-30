#!/usr/bin/env python3
from pathlib import Path
import csv, io, tarfile, requests

OUT = Path('test-assets/hindi-samples')
OUT.mkdir(parents=True, exist_ok=True)
TSV_URL = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data/hi_in/test.tsv'
TAR_URL = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data/hi_in/audio/test.tar.gz'

print('Downloading Hindi transcript index...')
tsv = requests.get(TSV_URL, timeout=60).text
rows = list(csv.reader(io.StringIO(tsv), delimiter='\t'))
# Pick first 10 unique audio files. FLEURS has separate speakers, not a real 10-person meeting.
wanted = {row[1]: row for row in rows[:10]}
for filename, row in wanted.items():
    (OUT / f'{Path(filename).stem}.txt').write_text(row[3] or row[2], encoding='utf-8')

print('Streaming first 10 Hindi WAV files from FLEURS test archive...')
with requests.get(TAR_URL, stream=True, timeout=120) as r:
    r.raise_for_status()
    r.raw.decode_content = True
    with tarfile.open(fileobj=r.raw, mode='r|gz') as tar:
        found = 0
        for member in tar:
            name = Path(member.name).name
            if name not in wanted:
                continue
            src = tar.extractfile(member)
            if not src:
                continue
            data = src.read()
            (OUT / name).write_bytes(data)
            found += 1
            print(f'[{found}/10] {name}')
            if found >= len(wanted):
                break
print(f'Done: {OUT.resolve()}')
