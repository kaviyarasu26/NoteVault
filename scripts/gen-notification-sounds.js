// Generates the two native Android notification-channel sounds as raw WAV
// files. There are no audio assets anywhere in this repo to draw on (see
// js/sound.js, which synthesizes its in-app chimes the same way via Web
// Audio) — these are the native equivalent, written directly as PCM since
// Node has no Web Audio API. Mirrors js/sound.js's ascending/descending
// convention: nv_default is the general "something happened" tone used by
// every channel except folder-share; nv_share is the deliberately
// descending, distinct tone for incoming folder-share invites.
//
// Android notification-channel sounds are immutable once a channel is
// created on a given device (see notifications.js's ensureNotificationChannels)
// — changing these files later requires a new channel id, not just
// re-running this script and re-syncing.
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;

function renderNotes(notes) {
  const totalDur = notes.reduce((s, n) => s + n.dur * 0.92, 0) + notes[notes.length - 1].dur * 0.08;
  const samples = new Float32Array(Math.ceil(totalDur * SAMPLE_RATE));
  let t0 = 0;
  notes.forEach(n => {
    const gain = n.gain != null ? n.gain : 0.5;
    const startSample = Math.floor(t0 * SAMPLE_RATE);
    const durSamples = Math.floor(n.dur * SAMPLE_RATE);
    for (let i = 0; i < durSamples; i++) {
      const idx = startSample + i;
      if (idx >= samples.length) break;
      const tt = i / SAMPLE_RATE;
      // Same quick-attack / exponential-decay envelope as js/sound.js's playTone.
      const env = tt < 0.015 ? tt / 0.015 : Math.exp(-(tt - 0.015) * 7);
      samples[idx] += Math.sin(2 * Math.PI * n.freq * tt) * gain * env;
    }
    t0 += n.dur * 0.92;
  });
  return samples;
}

function writeWav(filePath, floatSamples) {
  const pcm = Buffer.alloc(floatSamples.length * 2);
  for (let i = 0; i < floatSamples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, floatSamples[i]));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const byteRate = SAMPLE_RATE * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
  console.log('Wrote', filePath);
}

const RAW_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'raw');

writeWav(path.join(RAW_DIR, 'nv_default.wav'), renderNotes([
  { freq: 523.25, dur: 0.13, gain: 0.5 },
  { freq: 659.25, dur: 0.24, gain: 0.55 }
]));

writeWav(path.join(RAW_DIR, 'nv_share.wav'), renderNotes([
  { freq: 783.99, dur: 0.13, gain: 0.5 },
  { freq: 523.25, dur: 0.24, gain: 0.55 }
]));
