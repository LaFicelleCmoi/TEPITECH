/* =========================================================
   Offscreen document — Whisper WASM STT
   - Charge transformers.js (bundled, lib/transformers.min.js)
   - Charge le pipeline whisper-tiny.en (1ère fois = ~40 Mo, cache ensuite)
   - Reçoit des chunks PCM (Float32Array @ 16 kHz) via runtime.sendMessage
   - Renvoie le texte transcrit
   ========================================================= */

import { pipeline, env } from '../lib/transformers.min.js';

// Autorise les modèles distants (HF), désactive les modèles locaux.
env.allowRemoteModels = true;
env.allowLocalModels  = false;
// Les WASM d'onnxruntime sont récupérés depuis jsdelivr par défaut.
// On peut surcharger env.backends.onnx.wasm.wasmPaths si nécessaire.

let transcriberPromise = null;
let modelReady = false;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        quantized: true,
        progress_callback: (p) => {
          // Notifie les listeners du chargement du modèle
          try {
            chrome.runtime.sendMessage({
              type: 'WHISPER_PROGRESS',
              status: p.status,
              file:   p.file,
              progress: p.progress,
              loaded: p.loaded,
              total:  p.total,
            });
          } catch {}
        },
      }
    ).then((p) => {
      modelReady = true;
      try { chrome.runtime.sendMessage({ type: 'WHISPER_READY' }); } catch {}
      return p;
    });
  }
  return transcriberPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true, modelReady });
    return;
  }

  if (msg.type === 'OFFSCREEN_WARMUP') {
    getTranscriber()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_TRANSCRIBE') {
    (async () => {
      try {
        // Le PCM peut arriver sous plusieurs formes selon la version de Chrome :
        // - Float32Array (structured clone)
        // - ArrayBuffer
        // - Array<number> (fallback JSON)
        let pcm;
        if (msg.pcm instanceof Float32Array) pcm = msg.pcm;
        else if (msg.pcm instanceof ArrayBuffer) pcm = new Float32Array(msg.pcm);
        else if (Array.isArray(msg.pcm)) pcm = new Float32Array(msg.pcm);
        else if (msg.pcm && typeof msg.pcm === 'object') {
          // {0: v, 1: v, ...} fallback
          const keys = Object.keys(msg.pcm);
          pcm = new Float32Array(keys.length);
          for (let i = 0; i < keys.length; i++) pcm[i] = msg.pcm[i];
        } else {
          throw new Error('PCM invalide');
        }

        const transcriber = await getTranscriber();
        const result = await transcriber(pcm, {
          sampling_rate: msg.sampleRate || 16000,
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: false,
        });
        const text = (result?.text || '').trim();
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async
  }
});

// Signale la disponibilité au démarrage
try { chrome.runtime.sendMessage({ type: 'WHISPER_OFFSCREEN_LOADED' }); } catch {}
