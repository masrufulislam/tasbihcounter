const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  document.getElementById('status').textContent =
    'Web Speech API not supported. Use Chrome/Edge.';
  document.getElementById('startButton').disabled = true;
  document.getElementById('stopButton').disabled = true;
  document.getElementById('resetButton').disabled = true;
}

let recognition;
let isListening = false;
let restartTimeout = null;
let isResetting = false;

// UI elements (IDs kept from your original HTML)
const countEls = {
  subhanallah: document.getElementById('subhanallah-count'),
  alhamdulillah: document.getElementById('alhamdulillah-count'),
  allahuakbar: document.getElementById('allahuakbar-count'),
  lailahaillallah: document.getElementById('lailahaillallah-count'),
  astaghfirullah: document.getElementById('astaghfirullah-count'),
  hasbunallah: document.getElementById('hasbunallah-count'),
  salawatExtended: document.getElementById('salawat-extended-count'),
  subhanallahWaBihamdihi: document.getElementById('subhanallah-wa-bihamdihi-count'),
  subhanallahilAzeem: document.getElementById('subhanallahil-azeem-count'),
};

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const statusEl = document.getElementById('status');

// ---------- Counters & Animation State (source of truth: committedCounts) ----------
const committedCounts = {
  subhanallah: 0,
  alhamdulillah: 0,
  allahuakbar: 0,
  lailahaillallah: 0,
  astaghfirullah: 0,
  hasbunallah: 0,
  salawatExtended: 0,
  subhanallahWaBihamdihi: 0,
  subhanallahilAzeem: 0,
};

const displayedCounts = Object.assign({}, committedCounts); // what UI shows
const animIntervals = {}; // per-key animation interval
const ANIM_MS = 120; // animation step interval (ms)

for (const k in committedCounts) {
  animIntervals[k] = null;
}

// Phrase variations (expanded transliteration + Arabic)
const phrases = {
  subhanallah: [
    'subhanallah', 'subhan allah', 'subhan', 'subhan allah wa', 'سبحان الله',
    'subhan alaah', 'subhan allaah', 'subhan alah', 'subhanlah'
  ],
  alhamdulillah: [
    'Alhamdulillah', 'Al hamdulillah', 'Al hamdu lillah', 'Alhamdullilah',
    'Alhamdulila', 'الحمد لله', 'Al hamdulilah', 'Alhamdillah'
  ],
  allahuakbar: [
    'allahu akbar', 'allah akbar', 'allah hu akbar', 'allahuakbar', 'الله أكبر',
    'allahu akber', 'allahu akbaru', 'allahu akbarr', 'allahu akbarrr'
  ],
  lailahaillallah: [
    'la ilaha illallah', 'la ilaha illa allah', 'la ilaha illalah', 'la ilaha illallah',
    'لا إله إلا الله', 'la illaha illallah', 'la ilaha', 'la ilaha illa lah',
    'la ilaha illalah', 'la ilaha illallh', 'la ilaha illalahh'
  ],
  astaghfirullah: [
    'astaghfirullah', 'astagfirullah', 'astaghfir', 'astaghfiru', 'astaghfiru allah',
    'أستغفر الله', 'astaghfirullaha', 'astaghfirlah', 'astagfirullah',
    'astagfirullaha'
  ],
  hasbunallah: [
    'hasbunallah', 'hasbun allah wa ni mal wakeel', 'hasbuna allah', 'hasbunallah wanimal wakeel',
    'حسبنا الله ونعم الوكيل', 'hasbuna allah wa ni mal wakeel', 'hasbunallah w ni mal wakeel'
  ],
  salawatExtended: [
    'allahumma salli ala muhammad wa ala ali muhammad',
    'allahumma salli ala muhammad wa ala aali muhammad',
    'allahumma salli ala muhammad wa ala al muhammad',
    'اللهم صل على محمد وعلى آل محمد',
    'allahumma salli ala sayyidina muhammad wa ala ali sayyidina muhammad'
  ],
  subhanallahWaBihamdihi: [
    'subhanallah wa bihamdihi', 'subhan allah wa bihamdihi', 'سبحان الله وبحمده',
    'subhanallah w bihamdihi', 'subhanallah wa bihamdihi wa la ilaha illa Allah'
  ],
  subhanallahilAzeem: [
    'subhanallahil azeem', 'subhan allahil azeem', 'سبحان الله العظيم',
    'subhanallahil azim', 'subhanallahil azeem', 'subhanallahil azeem'
  ],
};

// ---------- Normalization & tokenization ----------
function stripCombiningMarks(s) {
  try {
    return s.normalize('NFD').replace(/\p{M}/gu, '');
  } catch (e) {
    return s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, '');
  }
}

function normalizeText(txt) {
  if (!txt) return '';
  let t = String(txt);
  t = stripCombiningMarks(t);
  t = t.toLowerCase();
  t = t.replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/([a-z])\1{2,}/g, '$1$1');
  return t;
}

function tokenize(normalized) {
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

// ---------- Build token-variation entries (longest-first) ----------
const entries = [];
(function buildEntries() {
  for (const key in phrases) {
    for (const v of phrases[key]) {
      const vn = normalizeText(v);
      if (!vn) continue;
      const vt = tokenize(vn);
      if (vt.length > 0) entries.push({ key, tokens: vt, len: vt.length });
    }
  }
  entries.sort((a, b) => b.len - a.len);
})();

// ---------- Token-based non-overlapping matcher ----------
function countOccurrencesInTokens(tokens) {
  const countsPerKey = {};
  for (const key in phrases) countsPerKey[key] = 0;
  
  const used = new Array(tokens.length).fill(false);

  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    for (const e of entries) {
      const L = e.len;
      if (i + L > tokens.length) continue;
      let match = true;
      for (let j = 0; j < L; j++) {
        if (used[i + j] || tokens[i + j] !== e.tokens[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        countsPerKey[e.key]++;
        for (let j = 0; j < L; j++) used[i + j] = true;
      }
    }
  }
  return countsPerKey;
}

// ---------- Animation logic: animate displayedCounts toward committedCounts ----------
function startAnimationForKey(key) {
  if (animIntervals[key]) return;

  animIntervals[key] = setInterval(() => {
    if (displayedCounts[key] < committedCounts[key]) {
      displayedCounts[key]++;
      countEls[key].textContent = displayedCounts[key];
    } else if (displayedCounts[key] > committedCounts[key]) {
      displayedCounts[key]--;
      countEls[key].textContent = displayedCounts[key];
    } else {
      clearInterval(animIntervals[key]);
      animIntervals[key] = null;
    }
  }, ANIM_MS);
}

function updateAllDisplayFromDisplayedCounts() {
  for (const k in displayedCounts) {
    countEls[k].textContent = displayedCounts[k];
  }
}
updateAllDisplayFromDisplayedCounts();

// ---------- Speech recognition tracking ----------
let processedOccurrencesPerResult = []; 
let appliedOccurrencesPerResult = [];   

// ---------- Mobile duplicate-final safeguard ----------
// Some mobile browsers (esp. Android Chrome) can emit the *same* final result
const RECENT_FINALS_WINDOW_MS = 1500; // 1.5s 
let recentFinals = []; // array of { h: number, t: ms }

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

function isDuplicateFinal(normalizedStr) {
  const now = Date.now();
  // prune old
  recentFinals = recentFinals.filter(e => now - e.t < RECENT_FINALS_WINDOW_MS);
  const h = simpleHash(normalizedStr);
  const seen = recentFinals.some(e => e.h === h);
  if (!seen) recentFinals.push({ h, t: now });
  return seen;
}

// ---------- Recognition init ----------
function initializeRecognition() {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ar-SA';

  const SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
  if (SpeechGrammarList) {
    try {
      const list = new SpeechGrammarList();
      const flat = Object.values(phrases).flat().map(p => p.replace(/\|/g, ' '));
      list.addFromString('#JSGF V1.0; grammar phrases; public <phrase> = ' + flat.join(' | ') + ' ;', 1.0);
      recognition.grammars = list;
    } catch (e) { /* ignore */ }
  }

  recognition.onstart = () => {
    statusEl.textContent = 'Listening...';
    processedOccurrencesPerResult = [];
    appliedOccurrencesPerResult = [];
    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }
  };

  recognition.onresult = (event) => {
    // event.resultIndex is the lowest index that changed
    const startIndex = event.resultIndex || 0;

    for (let i = startIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const isFinal = res.isFinal;
      const transcript = (res[0].transcript || '').trim();
      const normalized = normalizeText(transcript);
      const tokens = tokenize(normalized);

      // compute current occurrences for this result index
      const currentOccurrences = countOccurrencesInTokens(tokens);
      const previousSnapshot = processedOccurrencesPerResult[i] || {};
      // always update the processed snapshot (so we can inspect interims if needed)
      processedOccurrencesPerResult[i] = currentOccurrences;

      if (!isFinal) {
        // don't commit interim results — only log for debugging
        console.log(`Interim[${i}]:`, transcript, currentOccurrences);
        continue;
      }

      const previousApplied = appliedOccurrencesPerResult[i] || {};
      for (const key in committedCounts) {
        const prevAppliedCount = previousApplied[key] || 0;
        const currCount = currentOccurrences[key] || 0;
        const delta = Math.max(0, currCount - prevAppliedCount);

        if (delta > 0) {
          committedCounts[key] += delta;
          startAnimationForKey(key);
        }
      }
      appliedOccurrencesPerResult[i] = currentOccurrences;

      console.log(`Final[${i}]:`, transcript, currentOccurrences, 'committed:', JSON.parse(JSON.stringify(committedCounts)));
    }

    // Update status message based on last result
    const lastIsFinal = event.results[event.results.length - 1].isFinal;
    statusEl.textContent = lastIsFinal ? 'Listening...' : 'Listening... (interim)';
  };

  recognition.onend = () => {
    console.log('Recognition ended.');
    if (!isResetting) {
      if (isListening) {
        statusEl.textContent = 'Recognition paused, attempting to restart...';
        restartTimeout = setTimeout(() => {
          try {
            recognition.start();
          } catch (e) {
            console.error('Error restarting recognition:', e);
            statusEl.textContent = 'Error restarting microphone. Click Start again.';
            isListening = false;
            startButton.disabled = false;
            stopButton.disabled = true;
          }
        }, 500); // slightly longer restart gap to reduce "mic busy" errors
      } else {
        statusEl.textContent = 'Stopped listening.';
      }
    }
    isResetting = false;
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      statusEl.textContent = 'Microphone access denied. Allow mic access.';
    } else if (event.error === 'no-speech') {
      statusEl.textContent = 'No speech detected. Speak clearly.';
    } else {
      statusEl.textContent = `Error: ${event.error}`;
    }
    isListening = false;
    startButton.disabled = false;
    stopButton.disabled = true;
  };
}

// ---------- Controls ----------
startButton.addEventListener('click', () => {
  if (!recognition) initializeRecognition();
  if (!isListening) {
    try {
      recognition.start();
      isListening = true;
      startButton.disabled = true;
      stopButton.disabled = false;
      statusEl.textContent = 'Listening...';
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'Could not start microphone.';
    }
  }
});

stopButton.addEventListener('click', () => {
  if (recognition && isListening) {
    if (restartTimeout) clearTimeout(restartTimeout);
    recognition.stop();
    isListening = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    statusEl.textContent = 'Stopped listening.';
  }
});

resetButton.addEventListener('click', () => {
  isResetting = true;
  if (restartTimeout) clearTimeout(restartTimeout);
  if (recognition && isListening) {
    recognition.stop();
    isListening = false;
  }
  // clear animations & counts
  for (const key in committedCounts) {
    if (animIntervals[key]) {
      clearInterval(animIntervals[key]);
      animIntervals[key] = null;
    }
    committedCounts[key] = 0;
    displayedCounts[key] = 0;
  }
  processedOccurrencesPerResult = [];
  appliedOccurrencesPerResult = [];
  updateAllDisplayFromDisplayedCounts();
  startButton.disabled = false;
  stopButton.disabled = true;
  statusEl.textContent = 'Counts reset. Click "Start Listening" to begin again.';
});

initializeRecognition();
if (SpeechRecognition) statusEl.textContent = 'Click "Start Listening" to begin.';

// Mode Toggle
const modeToggleButton = document.getElementById('modeToggle');
const body = document.body;

function updateButtonText() {
    if (body.classList.contains('light-mode')) {
        modeToggleButton.textContent = '☀️ Light';
    } else {
        modeToggleButton.textContent = '🌙 Dark';
    }
}
updateButtonText(); 

modeToggleButton.addEventListener('click', () => {
    body.classList.toggle('light-mode');
    updateButtonText();
});
