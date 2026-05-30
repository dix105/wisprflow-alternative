#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [,, audioPath, expectedPath] = process.argv;
const apiKey = process.env.SARVAM_API_KEY || process.env.SARVAM_KEY;

if (!audioPath) {
  console.error('Usage: SARVAM_API_KEY=... node scripts/test-sarvam-hindi-sample.mjs <audio.wav|webm|mp3> [expected.txt]');
  process.exit(2);
}
if (!apiKey) {
  console.error('Missing SARVAM_API_KEY. Add a Sarvam key, then rerun this script.');
  process.exit(2);
}

const audio = readFileSync(audioPath);
const form = new FormData();
form.set('model', 'saaras:v3');
form.set('mode', 'transcribe');
form.set('file', new Blob([audio]), audioPath.split('/').pop() || 'sample.wav');

const response = await fetch('https://api.sarvam.ai/speech-to-text', {
  method: 'POST',
  headers: { 'api-subscription-key': apiKey },
  body: form,
});

const body = await response.text();
if (!response.ok) {
  console.error(`Sarvam API error ${response.status}: ${body}`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(body); } catch { parsed = { text: body }; }
const transcript = (parsed.transcript || parsed.text || '').trim();
console.log('\n--- SARVAM TRANSCRIPT ---\n');
console.log(transcript || body);
writeFileSync('sarvam-test-output.txt', transcript || body);

if (expectedPath) {
  const expected = readFileSync(expectedPath, 'utf8').trim();
  const expectedWords = expected.split(/\s+/).filter(Boolean);
  const gotWords = transcript.split(/\s+/).filter(Boolean);
  const hits = expectedWords.filter((word) => transcript.includes(word)).length;
  console.log('\n--- SIMPLE CHECK ---');
  console.log(`Expected words: ${expectedWords.length}`);
  console.log(`Transcript words: ${gotWords.length}`);
  console.log(`Expected-word exact substring hits: ${hits}/${expectedWords.length}`);
}
