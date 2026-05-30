#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = process.argv[2] || 'test-assets/hindi-samples';
const apiKey = process.env.SARVAM_API_KEY || process.env.SARVAM_KEY;
if (!apiKey) {
  console.error('Missing SARVAM_API_KEY. Example: SARVAM_API_KEY=... node scripts/test-sarvam-hindi-batch.mjs test-assets/hindi-samples');
  process.exit(2);
}

const wavs = readdirSync(dir).filter((name) => name.endsWith('.wav')).slice(0, 10);
if (!wavs.length) {
  console.error(`No .wav files found in ${dir}. Run: python3 scripts/fetch-fleurs-hindi-samples.py`);
  process.exit(2);
}
mkdirSync('test-results', { recursive: true });
const rows = [];

for (const name of wavs) {
  const audioPath = join(dir, name);
  const expectedPath = join(dir, name.replace(/\.wav$/, '.txt'));
  const expected = readFileSync(expectedPath, 'utf8').trim();
  const audio = readFileSync(audioPath);
  const form = new FormData();
  form.set('model', 'saaras:v3');
  form.set('mode', 'transcribe');
  form.set('file', new Blob([audio]), name);
  const response = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Sarvam API error ${response.status} on ${name}: ${body}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { text: body }; }
  const transcript = (parsed.transcript || parsed.text || '').trim();
  const expectedWords = expected.split(/\s+/).filter(Boolean);
  const hits = expectedWords.filter((word) => transcript.includes(word)).length;
  const hitRate = expectedWords.length ? hits / expectedWords.length : 0;
  rows.push({ file: name, expected, transcript, expectedWords: expectedWords.length, hits, hitRate });
  console.log(`${name}: ${(hitRate * 100).toFixed(1)}% exact word-substring hit rate`);
}

const md = ['# Sarvam Hindi sample test', '', ...rows.map((row) => `## ${row.file}\n\nExpected: ${row.expected}\n\nSarvam: ${row.transcript}\n\nExact word-substring hits: ${row.hits}/${row.expectedWords} (${(row.hitRate * 100).toFixed(1)}%)\n`)];
writeFileSync('test-results/sarvam-hindi-batch.md', md.join('\n'));
writeFileSync('test-results/sarvam-hindi-batch.json', JSON.stringify(rows, null, 2));
console.log('\nWrote test-results/sarvam-hindi-batch.md and .json');
