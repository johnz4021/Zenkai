/**
 * Spike 5: ElevenLabs Scribe v2 Realtime protocol, ground truth.
 *
 * Live session symptom: 4 speech segments in, 1 fragment ('Can we...') out,
 * 3 empty, one socket drop. Two hypotheses:
 *   A. commit_strategy defaults to `vad`; we stop streaming at speech_end so
 *      their VAD never sees trailing silence and never finalizes.
 *   B. our commit message (empty audio_base_64 + commit:true) is rejected
 *      with an error message_type we silently drop.
 *
 * This harness streams the SAME known-good 16k PCM sample three ways and
 * prints EVERY raw message. Run:
 *   node spikes/spike5-stt/harness.mjs   (needs ELEVENLABS_API_KEY)
 */
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const KEY = process.env.ELEVENLABS_API_KEY ?? process.env.IP_ELEVENLABS_KEY;
if (!KEY) {
  console.error('set ELEVENLABS_API_KEY');
  process.exit(1);
}

const wav = readFileSync('/tmp/ip-stt-sample.wav');
const pcm = wav.subarray(44); // strip WAV header
const CHUNK = 3200; // 100ms @ 16k PCM16

function run(name, url, plan) {
  return new Promise((resolve) => {
    console.log(`\n========== ${name} ==========`);
    console.log(`URL: ${url.replace(/token=[^&]+/, 'token=***')}`);
    const ws = new WebSocket(url, { headers: { 'xi-api-key': KEY } });
    const t0 = Date.now();
    const log = (dir, s) =>
      console.log(`  +${((Date.now() - t0) / 1000).toFixed(2)}s ${dir} ${s}`);
    const done = (why) => {
      log('--', `closing (${why})`);
      try { ws.close(); } catch {}
      resolve();
    };
    const timer = setTimeout(() => done('timeout 20s'), 20_000);
    ws.on('open', async () => {
      log('--', 'open');
      await plan({
        send: (obj) => {
          const summary = { ...obj, audio_base_64: obj.audio_base_64 ? `<${obj.audio_base_64.length}b64>` : obj.audio_base_64 };
          log('->', JSON.stringify(summary));
          ws.send(JSON.stringify(obj));
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    });
    ws.on('message', (d) => log('<-', String(d)));
    ws.on('error', (e) => log('!!', String(e)));
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      log('--', `closed code=${code} reason=${reason}`);
      resolve();
    });
  });
}

const BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime';

// Variant 1 — CURRENT session behavior: no extra params, chunks, then an
// empty-audio commit (what handleClientMessage does today).
await run('V1: current behavior (default strategy, empty-chunk commit)', BASE, async ({ send, sleep }) => {
  for (let i = 0; i < pcm.length; i += CHUNK) {
    send({ message_type: 'input_audio_chunk', audio_base_64: pcm.subarray(i, i + CHUNK).toString('base64') });
    await sleep(20);
  }
  send({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true });
  await sleep(8_000);
});

// Variant 2 — manual commit strategy declared in the URL; commit rides the
// LAST audio chunk instead of an empty one.
await run(
  'V2: commit_strategy=manual, commit on last chunk',
  `${BASE}&commit_strategy=manual&audio_format=pcm_16000`,
  async ({ send, sleep }) => {
    for (let i = 0; i < pcm.length; i += CHUNK) {
      const last = i + CHUNK >= pcm.length;
      send({
        message_type: 'input_audio_chunk',
        audio_base_64: pcm.subarray(i, i + CHUNK).toString('base64'),
        ...(last ? { commit: true } : {}),
      });
      await sleep(20);
    }
    await sleep(8_000);
  },
);

// Variant 3 — their VAD does the committing: stream speech PLUS one second
// of trailing silence, never send commit at all.
await run(
  'V3: commit_strategy=vad, trailing silence, no manual commit',
  `${BASE}&commit_strategy=vad&audio_format=pcm_16000`,
  async ({ send, sleep }) => {
    for (let i = 0; i < pcm.length; i += CHUNK) {
      send({ message_type: 'input_audio_chunk', audio_base_64: pcm.subarray(i, i + CHUNK).toString('base64') });
      await sleep(20);
    }
    const silence = Buffer.alloc(CHUNK).toString('base64');
    for (let i = 0; i < 15; i++) {
      send({ message_type: 'input_audio_chunk', audio_base_64: silence });
      await sleep(100);
    }
    await sleep(6_000);
  },
);

console.log('\ndone');
process.exit(0);
