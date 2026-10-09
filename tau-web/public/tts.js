/**
 * Speech — text-to-speech for tau-web, on the browser's Web Speech API.
 *
 * Engine choice: speechSynthesis runs on the device's own TTS engine (on
 * Android, Google Speech Services' voices). It needs no API key, ships no
 * reply text to a third party, adds no server RAM next to Pi, and works over
 * plain HTTP. Cloud TTS can sound marginally better but adds keys, cost,
 * latency and privacy exposure, and cannot work offline. If higher quality is
 * ever wanted, an `/api/tts` proxy streaming audio into an <audio> element can
 * slot in behind this same interface.
 *
 * Phone/Chrome quirks handled here:
 *  - voices arrive asynchronously (voiceschanged) and may be empty at load;
 *  - one long utterance gets cut off (~15 s) — text is split into sentence
 *    chunks and queued;
 *  - utterance objects are kept referenced until their end event (a GC'd
 *    utterance silently stops the audio);
 *  - failures (blocked autoplay, missing voice, network) surface via an
 *    'error' event instead of dying silently.
 */

const STORAGE_KEY = 'tau-web-tts';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function friendlyError(code) {
  switch (code) {
    case 'not-allowed':
      return 'The browser blocked speech — tap the speaker button again to allow it.';
    case 'network':
      return 'The selected voice needs a network connection.';
    case 'language-unavailable':
    case 'voice-unavailable':
      return 'The selected voice is not available on this device.';
    case 'synthesis-unavailable':
      return 'No speech engine is available on this device.';
    case 'synthesis-failed':
      return 'The speech engine failed to start.';
    default:
      return `Speech failed (${code || 'unknown error'}).`;
  }
}

// Markdown → speakable plain text. Code blocks become "Code block." (reading
// punctuation and identifiers aloud is noise); links keep their label; URLs
// become "link"; table pipes and formatting markers are dropped.
export function plainTextForSpeech(input) {
  let t = String(input ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' Code block. ');
  t = t.replace(/~~~[\s\S]*?~~~/g, ' Code block. ');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, ' link ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ''); // table separator rows
  t = t.replace(/\|/g, ' ');
  t = t.replace(/[*_~]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function speechBoundary(s, max) {
  const head = s.slice(0, max);
  // Prefer the last sentence end, then the last clause end, then a space.
  let last = -1;
  let m;
  const sentence = /[.!?…]["')\]]?\s/g;
  while ((m = sentence.exec(head))) last = m.index + m[0].length;
  if (last >= max * 0.4) return last;
  last = -1;
  const clause = /[;:,]\s/g;
  while ((m = clause.exec(head))) last = m.index + m[0].length;
  if (last >= max * 0.4) return last;
  const space = head.lastIndexOf(' ');
  return space > 0 ? space + 1 : max;
}

// Split into utterance-sized chunks. Chrome/Android cuts a single long
// utterance off after roughly 15 seconds, so anything longer than ~220 chars
// is broken at sentence (then clause, then word) boundaries.
export function splitForSpeech(text, max = 220) {
  const chunks = [];
  for (const para of String(text).split(/\n+/)) {
    let rest = para.trim();
    while (rest.length > max) {
      const cut = speechBoundary(rest, max);
      const head = rest.slice(0, cut).trim();
      if (head) chunks.push(head);
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

export class SpeechController extends EventTarget {
  constructor() {
    super();
    this.supported = typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && typeof SpeechSynthesisUtterance !== 'undefined';
    this.voices = [];
    this.settings = { autoRead: false, voiceURI: '', rate: 1, pitch: 1 };
    try {
      Object.assign(this.settings, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {}
    this._queue = [];
    this._current = null; // utterance held until its end (Chrome GC bug)
    this._element = null; // message element being read, for button state
    this._speaking = false;
    this._voiceSig = null;
    if (this.supported) {
      this._loadVoices();
      const synth = window.speechSynthesis;
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', () => this._loadVoices());
      }
      // Older engines only expose the property handler.
      synth.onvoiceschanged = () => this._loadVoices();
    }
  }

  get speaking() {
    return this._speaking;
  }

  getVoices() {
    return this.voices;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {}
    this._dispatch('settings', { settings: this.settings });
  }

  isSpeakingFor(element) {
    return this._speaking && this._element === element;
  }

  speak(text, opts = {}) {
    if (!this.supported) {
      this._error('Text-to-speech is not supported in this browser.');
      return;
    }
    const clean = plainTextForSpeech(text);
    const chunks = splitForSpeech(clean);
    this.stop();
    if (chunks.length === 0) return;
    this._element = opts.element || null;
    this._queue = chunks;
    this._speaking = true;
    this._dispatch('start', { element: this._element, text: clean });
    this._speakNext();
  }

  stop() {
    if (!this.supported) return;
    const wasSpeaking = this._speaking;
    this._queue = [];
    this._current = null;
    const synth = window.speechSynthesis;
    try {
      // Cancel only when something is actually pending; a cancel immediately
      // before a new speak can swallow the new utterance on Chrome.
      if (wasSpeaking || synth.speaking || synth.pending) synth.cancel();
    } catch {}
    this._finish();
  }

  _speakNext() {
    if (!this._speaking) return;
    const chunk = this._queue.shift();
    if (!chunk) {
      this._finish();
      return;
    }
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(chunk);
    const voice = this._voice();
    if (voice) utterance.voice = voice;
    utterance.rate = clamp(Number(this.settings.rate) || 1, 0.5, 2);
    utterance.pitch = clamp(Number(this.settings.pitch) || 1, 0, 2);
    utterance.onend = () => {
      this._current = null;
      this._speakNext();
    };
    utterance.onerror = (e) => {
      this._current = null;
      const code = e?.error || 'unknown';
      // cancel() reports 'interrupted'/'canceled' — that is a stop, not a bug.
      if (code === 'interrupted' || code === 'canceled') {
        this._finish();
        return;
      }
      this._error(friendlyError(code));
      this._finish();
    };
    this._current = utterance;
    try {
      if (synth.paused) synth.resume();
    } catch {}
    synth.speak(utterance);
  }

  _finish() {
    if (!this._speaking) return;
    this._speaking = false;
    const element = this._element;
    this._element = null;
    this._dispatch('end', { element });
  }

  _voice() {
    if (!this.voices.length) return null;
    const wanted = this.settings.voiceURI;
    if (wanted) {
      const hit = this.voices.find((v) => (v.voiceURI || v.name) === wanted);
      if (hit) return hit;
    }
    return this._defaultVoice();
  }

  // Prefer the device's best English voice: Google/neural/natural names first,
  // local (offline-capable) voices before network-only ones.
  _defaultVoice() {
    const english = this.voices.filter((v) => String(v.lang || '').toLowerCase().startsWith('en'));
    const pool = english.length ? english : this.voices;
    const score = (v) => {
      const name = String(v.name || '').toLowerCase();
      const lang = String(v.lang || '').toLowerCase();
      let s = 0;
      if (/google|microsoft|samsung/.test(name)) s += 4;
      if (/natural|neural|premium|enhanced|wavenet/.test(name)) s += 4;
      if (/network/.test(name)) s += 1;
      if (v.localService) s += 1;
      if (v.default) s += 2;
      if (lang.startsWith('en-us') || lang.startsWith('en-gb')) s += 1;
      return s;
    };
    return [...pool].sort((a, b) => score(b) - score(a))[0] || null;
  }

  _loadVoices() {
    const list = window.speechSynthesis.getVoices() || [];
    // Some engines hand back a new array with identical content every call.
    const sig = list.map((v) => v.voiceURI || v.name).join('|');
    if (sig === this._voiceSig) return;
    this._voiceSig = sig;
    this.voices = list;
    this._dispatch('voiceschanged', { voices: list });
  }

  _dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _error(message) {
    console.error('[TTS]', message);
    this._dispatch('error', { message });
  }
}
