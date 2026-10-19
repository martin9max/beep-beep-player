/* =====================================================================
   BEEP BEEP RADIO — Auto-ducking player (ista logika kao SIGNAL)
   ---------------------------------------------------------------------
   - Background music comes from a YouTube video/playlist, played
     through the YouTube IFrame Player API (video is hidden off-screen,
     only the audio matters).
   - Every AD_INTERVAL_MS, a local audio file ("reklama") plays instead:
     the YouTube volume is ducked down to DUCK_VOLUME_PERCENT and the
     ad plays at full volume. When the ad ends, the music volume is
     restored and the cycle starts again.
   - If the configured YouTube video refuses to play in an embedded
     player (owner-restricted — common on reuploaded mixes with
     commercial music), the player automatically falls back to a
     known-working stream instead of going silent.
   ===================================================================== */

// ---------------------------------------------------------------------
// 1. CONFIG — edit these to change behaviour
// ---------------------------------------------------------------------

// Your afro house summer mix pick:
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
// This is a `let`, not `const` — the test panel in the UI changes it
// live while you're trying the app out (see section 11 below).
let AD_INTERVAL_MS = 3 * 60 * 1000;

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

// ---------------------------------------------------------------------
// 2. STATE
// ---------------------------------------------------------------------

let ytPlayer = null;
let ytReady = false;
let usedFallback = false;

let isPlaying = false;
let isAdPlaying = false;

let userVolume = 70;     // the volume the user has chosen (0-100)
let playbackRate = 1;    // shared between music and ads

let lastAdIndex = -1;
const adAudioEl = new Audio();
adAudioEl.preload = 'auto';

let nextAdAt = null;       // Date.now() timestamp for the next scheduled ad
let remainingMsOnPause = null;
let adSchedulerTimeout = null;
let countdownInterval = null;

// ---------------------------------------------------------------------
// 3. DOM REFERENCES
// ---------------------------------------------------------------------

const playBtn         = document.getElementById('playBtn');
const iconPlay         = document.getElementById('iconPlay');
const iconPause        = document.getElementById('iconPause');
const statusLabel      = document.getElementById('statusLabel');
const countdownLabel   = document.getElementById('countdownLabel');
const ringProgress     = document.getElementById('ringProgress');
const lamp             = document.getElementById('lamp');
const nowPlaying       = document.getElementById('nowPlaying');
const volumeSlider     = document.getElementById('volumeSlider');
const volumeValue      = document.getElementById('volumeValue');
const rateButtons      = document.querySelectorAll('.rate-btn');
const rateValue        = document.getElementById('rateValue');
const intervalInput    = document.getElementById('intervalInput');
const applyIntervalBtn = document.getElementById('applyIntervalBtn');
const intervalHint     = document.getElementById('intervalHint');

const RING_CIRCUMFERENCE = 565.48;

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
  ytPlayer.setPlaybackRate(playbackRate);

  if (usedFallback) {
    nowPlaying.textContent = 'Originalni mix nije mogao da se pusti (embed ograničen) — koristi se rezervna muzika.';
  } else if (!isPlaying) {
    nowPlaying.textContent = 'Klikni Play da započneš emitovanje';
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
    nowPlaying.textContent = 'Tvoj mix ne dozvoljava embed — prebacujem na rezervnu pozadinsku muziku…';
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
    nowPlaying.textContent = 'Plejer se ne učitava. Proveri da nemaš ad-blocker/ekstenziju koja blokira YouTube embed (probaj u Incognito bez ekstenzija), i proveri konzolu (F12) za greške.';
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
  nowPlaying.textContent = 'Emitovanje uživo — muzika u pozadini';

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
  nowPlaying.textContent = 'Pauzirano';

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
  startRing(delayMs);
  startCountdown();

  clearTimeout(adSchedulerTimeout);
  adSchedulerTimeout = setTimeout(playAd, delayMs);
  console.log(`Sledeća reklama zakazana za ${Math.round(delayMs / 1000)} sekundi.`);
}

function playAd() {
  if (!isPlaying) return;

  isAdPlaying = true;
  setAdLive();
  statusLabel.textContent = 'Reklama';
  nowPlaying.textContent = 'Reklama u toku…';

  // Duck the music.
  if (ytReady) ytPlayer.setVolume(DUCK_VOLUME_PERCENT);

  const index = pickNextAdIndex();
  const file = AD_FILES[index];
  adAudioEl.src = `assets/audio/${encodeURIComponent(file)}`;
  adAudioEl.volume = 1; // ad plays at 100%
  adAudioEl.playbackRate = playbackRate;

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
  statusLabel.textContent = 'Muzika';
  nowPlaying.textContent = 'Emitovanje uživo — muzika u pozadini';
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
// 7. RING TIMER + COUNTDOWN LABEL
// ---------------------------------------------------------------------

function startRing(durationMs) {
  ringProgress.classList.add('no-transition');
  ringProgress.style.strokeDashoffset = '0';
  // force reflow so the next style change is treated as a new transition
  void ringProgress.offsetWidth;
  ringProgress.classList.remove('no-transition');
  ringProgress.style.transition = `stroke-dashoffset ${durationMs / 1000}s linear`;
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
}

function startCountdown() {
  clearInterval(countdownInterval);
  updateCountdownLabel();
  countdownInterval = setInterval(updateCountdownLabel, 1000);
}

function updateCountdownLabel() {
  const remaining = Math.max(0, nextAdAt - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  countdownLabel.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// 8. LAMP / RING COLOUR STATE
// ---------------------------------------------------------------------

function setLive() {
  statusLabel.classList.remove('is-ad');
  lamp.classList.remove('is-ad');
  lamp.classList.add('is-live');
  ringProgress.classList.remove('is-ad');
}

function setAdLive() {
  statusLabel.classList.add('is-ad');
  lamp.classList.remove('is-live');
  lamp.classList.add('is-ad');
  ringProgress.classList.add('is-ad');
}

function setOff() {
  statusLabel.classList.remove('is-ad');
  lamp.classList.remove('is-live', 'is-ad');
}

// ---------------------------------------------------------------------
// 9. VOLUME CONTROL
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
// 10. PLAYBACK RATE CONTROL
// ---------------------------------------------------------------------

rateButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    playbackRate = Number(btn.dataset.rate);
    rateValue.textContent = `${playbackRate.toFixed(2)}x`;

    rateButtons.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');

    if (ytReady) ytPlayer.setPlaybackRate(playbackRate);
    adAudioEl.playbackRate = playbackRate;
  });
});

// ---------------------------------------------------------------------
// 11. TEST PANEL — change the ad interval on the fly (e.g. 10s while
//     testing, instead of waiting 3 real minutes each time).
// ---------------------------------------------------------------------

applyIntervalBtn.addEventListener('click', () => {
  const seconds = Number(intervalInput.value);

  if (!Number.isFinite(seconds) || seconds < 5) {
    intervalHint.textContent = 'Unesi broj sekundi, minimum 5.';
    return;
  }

  AD_INTERVAL_MS = seconds * 1000;
  intervalHint.textContent = seconds >= 60
    ? `Trenutni interval: ${seconds} sek (${(seconds / 60).toFixed(1)} min)`
    : `Trenutni interval: ${seconds} sek`;

  // If music is currently playing (and no ad is running right now),
  // restart the countdown immediately with the new interval so you
  // don't have to wait out the old one first.
  if (isPlaying && !isAdPlaying) {
    clearTimeout(adSchedulerTimeout);
    clearInterval(countdownInterval);
    scheduleNextAd(AD_INTERVAL_MS);
  }
});
