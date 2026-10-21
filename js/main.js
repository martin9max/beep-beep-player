/* =====================================================================
   BEEP BEEP DOSTAVA — Auto-ducking player (ista logika kao SIGNAL)
   ---------------------------------------------------------------------
   - Background music comes from a YouTube video/playlist, played
     through the YouTube IFrame Player API (video is hidden off-screen,
     only the audio matters).
   - Every AD_INTERVAL_MS, a local audio file ("reklama") plays instead:
     the YouTube volume is ducked down to DUCK_VOLUME_PERCENT and the
     ad plays at full volume. When the ad ends, the music volume is
     restored and the cycle starts again.
   - While the music plays, a Beep Beep van drives one lap around the
     ring. When it reaches the pin it honks and the ad plays; its text
     is shown on a "dostavnica" (delivery slip).
   - If the configured YouTube video refuses to play in an embedded
     player (owner-restricted — common on reuploaded mixes with
     commercial music), the player automatically falls back to a
     known-working stream instead of going silent.
   ===================================================================== */

// ---------------------------------------------------------------------
// 1. CONFIG — edit these to change behaviour
// ---------------------------------------------------------------------

// Afro house summer mix:
// https://www.youtube.com/watch?v=3G8f9miKY2A&list=RD3G8f9miKY2A&start_radio=1
const PRIMARY_VIDEO_ID = '3G8f9miKY2A';
const PRIMARY_LIST_ID  = 'RD3G8f9miKY2A';

// Used automatically ONLY if the primary video/playlist errors out
// (embedding disabled, video removed, etc) — so music never just goes
// silent. Anjunadeep Radio's official 24/7 livestream, known to allow
// embedding.
const FALLBACK_VIDEO_ID = 'D4MdHQOILdw';
const FALLBACK_LIST_ID  = null;

// How often an ad interrupts the music (in ms). 3 minutes = 180000.
// Changed live from the interval panel (section 11), remembered on this
// device, and can be forced with ?interval=10 (seconds) in the URL.
const INTERVAL_STORAGE_KEY = 'bb-ad-interval-sec';
let AD_INTERVAL_MS = 3 * 60 * 1000;
try {
  const saved = Number(localStorage.getItem(INTERVAL_STORAGE_KEY));
  if (Number.isFinite(saved) && saved >= 5) AD_INTERVAL_MS = saved * 1000;
} catch (e) { /* storage unavailable — keep default */ }
const urlInterval = Number(new URLSearchParams(location.search).get('interval'));
if (Number.isFinite(urlInterval) && urlInterval >= 5) {
  AD_INTERVAL_MS = urlInterval * 1000;
}

// Music volume while an ad is playing (0-100).
const DUCK_VOLUME_PERCENT = 20;

// 8 Beep Beep Dostava ads (texts in assets/audio/tekstovi-reklama.txt).
// Put them in /assets/audio/ using exactly these names.
const AD_FILES = [
  'ad1.m4a',
  'ad2.m4a',
  'ad3.m4a',
  'ad4.m4a',
  'ad5.m4a',
  'ad6.m4a',
  'ad7.m4a',
  'ad8.m4a',
];

// What each ad says, shown on the delivery slip while it plays.
// Same order as AD_FILES.
const AD_TEXTS = [
  'Gladni ste, a ne stižete do restorana? Topao obrok iz partnerskih restorana, pravo na vrata.',
  'Fali hleb, mleko ili sok? Ne morate da izlazite. Namirnice i piće iz marketa do vaše kuće.',
  'Rođendan, godišnjica, ili samo želite nekoga da obradujete? Buket ili saksija iz cvećare.',
  'Živite u nekom selu oko Negotina? Nema problema. Stižemo i do vas.',
  'Izaberete lokal i stavke iz menija, upišete adresu i telefon. Mi preuzimamo, vozimo i javljamo kad krećemo.',
  'Dok vi sedite ovde, mi smo već na putu. Hrana, piće, namirnice i cveće.',
  'Kiša, vrućina, gužva? Ostanite gde jeste. Donosimo ono što vam treba, do samih vrata.',
  'Jedan klik, jedan poziv, i paket je na putu. Kad čujete beep beep, to smo mi.',
];

// ---------------------------------------------------------------------
// 2. STATE
// ---------------------------------------------------------------------

let ytPlayer = null;
let ytReady = false;
let usedFallback = false;

let isPlaying = false;
let isAdPlaying = false;

let userVolume = 70;     // the volume the user has chosen (0-100)

let lastAdIndex = -1;
let deliveryCount = 0;
const adAudioEl = new Audio();
adAudioEl.preload = 'auto';

let nextAdAt = null;       // Date.now() timestamp for the next scheduled ad
let remainingMsOnPause = null;
let adSchedulerTimeout = null;
let countdownInterval = null;
let serviceInterval = null;
let activeService = 0;

// ---------------------------------------------------------------------
// 3. DOM REFERENCES
// ---------------------------------------------------------------------

const playBtn        = document.getElementById('playBtn');
const iconPlay       = document.getElementById('iconPlay');
const iconPause      = document.getElementById('iconPause');
const statusLabel    = document.getElementById('statusLabel');
const countdownLabel = document.getElementById('countdownLabel');
const ringProgress   = document.getElementById('ringProgress');
const lamp           = document.getElementById('lamp');
const nowPlaying     = document.getElementById('nowPlaying');
const volumeSlider   = document.getElementById('volumeSlider');
const volumeValue    = document.getElementById('volumeValue');
const van            = document.getElementById('van');
const services       = document.getElementById('services');
const serviceEls     = document.querySelectorAll('.service');
const adSlip         = document.getElementById('adSlip');
const adSlipText     = document.getElementById('adSlipText');
const adSlipNo       = document.getElementById('adSlipNo');
const adSlipBar      = document.getElementById('adSlipBar');

const RING_CIRCUMFERENCE = 565.48;
const RING_CENTER = 110;   // centre of .ring-wrap (220px)
const RING_RADIUS = 90;

const MSG_DRIVING = 'Muzika svira, kombi je na putu';

adAudioEl.addEventListener('error', () => {
  if (!adAudioEl.src) return;
  console.error('Greška pri učitavanju fajla reklame:', adAudioEl.currentSrc);
  nowPlaying.textContent = 'Greška: fajl reklame nije pronađen u assets/audio/ (proveri konzolu F12 i naziv fajla).';
});

// ---------------------------------------------------------------------
// 4. YOUTUBE IFRAME API
// ---------------------------------------------------------------------

// Called automatically by the YouTube IFrame API script once it has
// loaded (this exact function name is required by the API).
function onYouTubeIframeAPIReady() {
  initYouTubePlayer(PRIMARY_VIDEO_ID, PRIMARY_LIST_ID);
}

function initYouTubePlayer(videoId, listId) {
  const playerVars = {
    autoplay: 0,
    controls: 0,
    playsinline: 1,
    iv_load_policy: 3,
    modestbranding: 1,
    disablekb: 1,
  };

  // A real playlist/radio-mix ID needs listType+list+loop; a plain
  // video ID gets loop:1 + playlist:videoId (YouTube's documented way
  // to loop a single video/livestream).
  if (listId) {
    playerVars.listType = 'playlist';
    playerVars.list = listId;
    playerVars.loop = 1;
  } else {
    playerVars.loop = 1;
    playerVars.playlist = videoId;
  }

  ytPlayer = new YT.Player('yt-player', {
    videoId: videoId,
    playerVars,
    events: {
      onReady: onPlayerReady,
      onError: onPlayerError,
    },
  });
}

function onPlayerReady() {
  ytReady = true;
  ytPlayer.setVolume(isAdPlaying ? DUCK_VOLUME_PERCENT : userVolume);

  if (usedFallback) {
    nowPlaying.textContent = 'Originalni mix nije mogao da se pusti (embed ograničen), koristi se rezervna muzika.';
  } else if (!isPlaying) {
    nowPlaying.textContent = 'Klikni Play i kombi kreće';
  }

  // If the user had already hit Play before a fallback swap happened,
  // keep the music going on the new player instance.
  if (isPlaying) {
    ytPlayer.playVideo();
  }
}

// YouTube error codes:
// 2   = invalid video ID
// 5   = HTML5 player error
// 100 = video not found / removed / private
// 101 / 150 = the video's owner does not allow it to be played in
//             embedded players (very common on reuploaded DJ mixes /
//             compilations that contain other people's music).
function onPlayerError(event) {
  const messages = {
    2: 'Nevažeći video ID.',
    5: 'Greška u HTML5 plejeru.',
    100: 'Video nije pronađen (obrisan je ili je privatan).',
    101: 'Vlasnik ovog videa je onemogućio puštanje u embed plejerima.',
    150: 'Vlasnik ovog videa je onemogućio puštanje u embed plejerima.',
  };
  console.error('YouTube player error', event.data, messages[event.data] || '');

  const isEmbedIssue = [2, 100, 101, 150].includes(event.data);

  if (isEmbedIssue && !usedFallback) {
    usedFallback = true;
    console.warn('Prebacujem na rezervnu muziku zbog greške', event.data);
    nowPlaying.textContent = 'Mix ne dozvoljava embed, prebacujem na rezervnu muziku…';
    ytReady = false;
    try { ytPlayer.destroy(); } catch (e) { /* ignore */ }
    initYouTubePlayer(FALLBACK_VIDEO_ID, FALLBACK_LIST_ID);
    return;
  }

  // Either already on the fallback and it also failed, or a
  // non-embed-related error — surface it plainly.
  nowPlaying.textContent = `Greška: ${messages[event.data] || 'nepoznat problem sa YouTube plejerom.'} Proveri konzolu (F12).`;
}

// If the player still isn't ready after a while, it's very likely an
// ad-blocker/privacy extension blocking YouTube embeds entirely.
setTimeout(() => {
  if (!ytReady) {
    console.warn('YouTube plejer se nije inicijalizovao u razumnom roku.');
    nowPlaying.textContent = 'Plejer se ne učitava. Proveri da nemaš ad-blocker koji blokira YouTube (probaj u Incognito prozoru).';
  }
}, 8000);

// ---------------------------------------------------------------------
// 5. PLAY / PAUSE
// ---------------------------------------------------------------------

playBtn.addEventListener('click', () => {
  if (!ytReady) {
    console.warn('YouTube plejer još nije spreman (ytReady = false).');
    nowPlaying.textContent = 'Plejer se još učitava… sačekaj par sekundi i probaj ponovo.';
    return;
  }
  isPlaying ? pauseEverything() : startEverything();
});

function startEverything() {
  isPlaying = true;
  iconPlay.classList.add('hidden');
  iconPause.classList.remove('hidden');
  nowPlaying.textContent = MSG_DRIVING;

  ytPlayer.setVolume(userVolume);
  ytPlayer.playVideo();
  setLive();

  // Resume a paused ad-countdown, or start a fresh cycle.
  const delay = remainingMsOnPause !== null ? remainingMsOnPause : AD_INTERVAL_MS;
  remainingMsOnPause = null;
  scheduleNextAd(delay);
}

function pauseEverything() {
  isPlaying = false;
  iconPlay.classList.remove('hidden');
  iconPause.classList.add('hidden');
  nowPlaying.textContent = 'Pauzirano, kombi je parkiran';

  ytPlayer.pauseVideo();
  if (!adAudioEl.paused) adAudioEl.pause();

  clearTimeout(adSchedulerTimeout);
  clearInterval(countdownInterval);

  if (nextAdAt) {
    remainingMsOnPause = Math.max(0, nextAdAt - Date.now());
  }
  setOff();
}

// ---------------------------------------------------------------------
// 6. AD SCHEDULING + DUCKING
// ---------------------------------------------------------------------

function scheduleNextAd(delayMs) {
  nextAdAt = Date.now() + delayMs;
  startCountdown();

  clearTimeout(adSchedulerTimeout);
  adSchedulerTimeout = setTimeout(playAd, delayMs);
  console.log(`Sledeća reklama zakazana za ${Math.round(delayMs / 1000)} sekundi.`);
}

function playAd() {
  if (!isPlaying) return;

  isAdPlaying = true;
  setAdLive();
  statusLabel.textContent = 'Beep beep!';
  nowPlaying.textContent = 'Kombi je stigao, poruka za vas';

  // Duck the music.
  if (ytReady) ytPlayer.setVolume(DUCK_VOLUME_PERCENT);

  const index = pickNextAdIndex();
  const file = AD_FILES[index];
  showSlip(index);
  adAudioEl.src = `assets/audio/${encodeURIComponent(file)}`;
  adAudioEl.volume = 1; // ad plays at 100%

  console.log('Puštam reklamu:', file);

  adAudioEl.currentTime = 0;
  adAudioEl.play().then(() => {
    console.log('Reklama uspešno pokrenuta:', file);
  }).catch((err) => {
    // If the file is missing/unplayable, don't get stuck — recover
    // after a short delay so music keeps rotating on schedule.
    console.error('Reklama nije mogla da se pusti:', file, err);
    nowPlaying.textContent = `Greška: fajl "${file}" nije mogao da se pusti (proveri konzolu F12).`;
    onAdFinished();
  });

  adAudioEl.onended = onAdFinished;
}

function onAdFinished() {
  isAdPlaying = false;
  hideSlip();
  nowPlaying.textContent = MSG_DRIVING;
  setLive();

  // Restore the music to the user's chosen volume.
  if (isPlaying) {
    if (ytReady) ytPlayer.setVolume(userVolume);
    scheduleNextAd(AD_INTERVAL_MS);
  }
}

function pickNextAdIndex() {
  if (AD_FILES.length === 1) return 0;
  let index;
  do {
    index = Math.floor(Math.random() * AD_FILES.length);
  } while (index === lastAdIndex);
  lastAdIndex = index;
  return index;
}

// ---------------------------------------------------------------------
// 7. DELIVERY SLIP + SERVICES
// ---------------------------------------------------------------------

function showSlip(index) {
  deliveryCount += 1;
  adSlipNo.textContent = `#${String(deliveryCount).padStart(3, '0')}`;
  adSlipText.textContent = AD_TEXTS[index] || 'Beep Beep Dostava, Negotin i okolna sela.';
  adSlipBar.style.width = '0%';
  services.classList.add('hidden');
  adSlip.classList.remove('hidden');
}

function hideSlip() {
  adSlip.classList.add('hidden');
  services.classList.remove('hidden');
}

function startServiceCycle() {
  clearInterval(serviceInterval);
  highlightService(activeService);
  serviceInterval = setInterval(() => {
    activeService = (activeService + 1) % serviceEls.length;
    highlightService(activeService);
  }, 4000);
}

function stopServiceCycle() {
  clearInterval(serviceInterval);
  serviceEls.forEach((el) => el.classList.remove('is-active'));
}

function highlightService(i) {
  serviceEls.forEach((el, n) => el.classList.toggle('is-active', n === i));
}

// ---------------------------------------------------------------------
// 8. ROUTE RING + VAN + COUNTDOWN LABEL
// ---------------------------------------------------------------------

// How much of the lap the van has driven (0 = start, 1 = at the pin).
function routeFraction() {
  if (isAdPlaying) return 1;
  if (nextAdAt === null) return 0;
  const remaining = isPlaying
    ? nextAdAt - Date.now()
    : (remainingMsOnPause !== null ? remainingMsOnPause : AD_INTERVAL_MS);
  return Math.min(1, Math.max(0, 1 - remaining / AD_INTERVAL_MS));
}

function renderRoute() {
  const f = routeFraction();
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - f));

  const angle = f * Math.PI * 2;
  const x = RING_CENTER + RING_RADIUS * Math.sin(angle) - van.offsetWidth / 2;
  const y = RING_CENTER - RING_RADIUS * Math.cos(angle) - van.offsetHeight / 2;
  van.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad)`;

  if (isAdPlaying && adAudioEl.duration) {
    adSlipBar.style.width = `${(adAudioEl.currentTime / adAudioEl.duration) * 100}%`;
  }

  requestAnimationFrame(renderRoute);
}
requestAnimationFrame(renderRoute);

function startCountdown() {
  clearInterval(countdownInterval);
  updateCountdownLabel();
  countdownInterval = setInterval(updateCountdownLabel, 1000);
}

function formatMs(ms) {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateCountdownLabel() {
  countdownLabel.textContent = formatMs(nextAdAt - Date.now());
}
countdownLabel.textContent = formatMs(AD_INTERVAL_MS);

// ---------------------------------------------------------------------
// 9. LAMP / RING / VAN STATE
// ---------------------------------------------------------------------

function setLive() {
  statusLabel.textContent = 'Na putu';
  statusLabel.classList.remove('is-ad');
  lamp.classList.remove('is-ad');
  lamp.classList.add('is-live');
  ringProgress.classList.remove('is-ad');
  van.classList.remove('is-honking');
  van.classList.add('is-driving');
  startServiceCycle();
}

function setAdLive() {
  statusLabel.classList.add('is-ad');
  lamp.classList.remove('is-live');
  lamp.classList.add('is-ad');
  ringProgress.classList.add('is-ad');
  van.classList.remove('is-driving');
  van.classList.add('is-honking');
  stopServiceCycle();
}

function setOff() {
  statusLabel.textContent = 'Parkiran';
  statusLabel.classList.remove('is-ad');
  lamp.classList.remove('is-live', 'is-ad');
  van.classList.remove('is-driving', 'is-honking');
  stopServiceCycle();
}

// ---------------------------------------------------------------------
// 10. VOLUME CONTROL
// ---------------------------------------------------------------------

volumeSlider.addEventListener('input', (e) => {
  userVolume = Number(e.target.value);
  volumeValue.textContent = `${userVolume}%`;
  // Only push it live if we're not mid-ad (ad always stays at 100%).
  if (ytReady && !isAdPlaying) {
    ytPlayer.setVolume(userVolume);
  }
});

// ---------------------------------------------------------------------
// 11. AD INTERVAL PANEL — preset chips (1/3/5/10 min) or own seconds.
// ---------------------------------------------------------------------

const intervalButtons  = document.querySelectorAll('#intervalButtons .chip');
const intervalInput    = document.getElementById('intervalInput');
const applyIntervalBtn = document.getElementById('applyIntervalBtn');
const intervalValue    = document.getElementById('intervalValue');
const intervalHint     = document.getElementById('intervalHint');

function formatInterval(seconds) {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds > 60) return `${Math.floor(seconds / 60)} min ${seconds % 60} sek`;
  return `${seconds} sek`;
}

function renderIntervalPanel() {
  const seconds = Math.round(AD_INTERVAL_MS / 1000);
  intervalValue.textContent = formatInterval(seconds);
  intervalButtons.forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.seconds) === seconds);
  });
}

function setAdInterval(seconds) {
  AD_INTERVAL_MS = seconds * 1000;
  try { localStorage.setItem(INTERVAL_STORAGE_KEY, String(seconds)); } catch (e) { /* ignore */ }
  renderIntervalPanel();
  intervalHint.textContent = `Kombi sada stiže sa reklamom na svakih ${formatInterval(seconds)}.`;

  // Restart the lap right away with the new interval (unless an ad is
  // playing now — the new interval then starts after it ends).
  if (isPlaying && !isAdPlaying) {
    clearTimeout(adSchedulerTimeout);
    clearInterval(countdownInterval);
    scheduleNextAd(AD_INTERVAL_MS);
  } else if (!isPlaying) {
    remainingMsOnPause = null;
    nextAdAt = null;
    countdownLabel.textContent = formatMs(AD_INTERVAL_MS);
  }
}

intervalButtons.forEach((btn) => {
  btn.addEventListener('click', () => setAdInterval(Number(btn.dataset.seconds)));
});

applyIntervalBtn.addEventListener('click', () => {
  const seconds = Math.round(Number(intervalInput.value));
  if (!Number.isFinite(seconds) || seconds < 5) {
    intervalHint.textContent = 'Unesi broj sekundi, najmanje 5.';
    return;
  }
  setAdInterval(seconds);
  intervalInput.value = '';
});

intervalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyIntervalBtn.click();
});

renderIntervalPanel();
