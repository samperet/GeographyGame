(function () {
    'use strict';

    const STORE_KEY = 'geography-game-state-v1';

    const continents = ["Africa", "Asia", "Europe", "North America", "South America", "Australia", "Antarctica"];

    // Natural Earth uses "Oceania"; the game UI uses "Australia".
    const continentRename = { 'Oceania': 'Australia' };
    const skipContinents = new Set(['Seven seas (open ocean)']);

    // Natural Earth sets iso_a2 to "-99" for a handful of features. Override
    // the major ones; the rest (unrecognized states) are skipped.
    const isoA2Override = {
        'France': 'fr',
        'Norway': 'no',
        'Kosovo': 'xk'
    };

    const mapStyle = [
        { featureType: "water",          elementType: "geometry", stylers: [{ color: "#193341" }] },
        { featureType: "landscape",      elementType: "geometry", stylers: [{ color: "#2c5a71" }] },
        { featureType: "road",           elementType: "geometry", stylers: [{ color: "#29768a" }, { lightness: -37 }] },
        { featureType: "poi",            elementType: "geometry", stylers: [{ color: "#406d80" }] },
        { featureType: "transit",        elementType: "geometry", stylers: [{ color: "#406d80" }] },
        { elementType: "labels.text.stroke", stylers: [{ visibility: "on" }, { color: "#3e606f" }, { weight: 2 }, { gamma: 0.84 }] },
        { elementType: "labels.text.fill",   stylers: [{ color: "#ffffff" }] },
        { featureType: "administrative", elementType: "geometry", stylers: [{ weight: 0.6 }, { color: "#1a3541" }] },
        { elementType: "geometry",       stylers: [{ color: "#1a3541" }] }
    ];

    const countryDisplay = document.getElementById("country");
    const countryFlag = document.getElementById("country-flag");
    const resultDisplay = document.getElementById("result");
    const continentButtonsContainer = document.getElementById("continent-buttons");
    const scoreboard = document.getElementById("scoreboard");
    const skipButton = document.getElementById("skip-button");
    const nextButton = document.getElementById("next-button");
    const splashScreen = document.getElementById("splash-screen");
    const startButton = document.getElementById("start-button");
    const gameContainer = document.getElementById("game-container");
    const muteButton = document.getElementById("mute-button");

    let countryData = [];
    let queue = [];
    let currentCountry = null;
    let map = null;
    let countryLayer = null;
    let geojsonPromise = null;
    let gameInitialized = false;
    let firstTryWrong = false;
    let score = 0;
    let attempts = 0;
    let streak = 0;
    let bestStreak = 0;

    // ---- Persistent state -----------------------------------------------

    function loadStore() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) {
            return {};
        }
    }

    function saveStore(patch) {
        try {
            const cur = loadStore();
            const next = Object.assign({}, cur, patch);
            localStorage.setItem(STORE_KEY, JSON.stringify(next));
        } catch (e) { /* quota / private mode */ }
    }

    const persisted = loadStore();
    bestStreak = typeof persisted.bestStreak === 'number' ? persisted.bestStreak : 0;
    let muted = !!persisted.muted;

    // ---- Audio engine (Web Audio synth — no external sound files) -------

    const audio = (function () {
        let ctx = null;
        let masterGain = null;
        let musicGain = null;
        let sfxGain = null;
        let musicTimer = null;

        function ensureCtx() {
            if (ctx) {
                if (ctx.state === 'suspended') ctx.resume();
                return ctx;
            }
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            masterGain = ctx.createGain();
            masterGain.gain.value = muted ? 0 : 0.6;
            masterGain.connect(ctx.destination);
            musicGain = ctx.createGain();
            musicGain.gain.value = 0.18;
            musicGain.connect(masterGain);
            sfxGain = ctx.createGain();
            sfxGain.gain.value = 0.55;
            sfxGain.connect(masterGain);
            return ctx;
        }

        function setMuted(v) {
            if (masterGain) {
                masterGain.gain.cancelScheduledValues(ctx.currentTime);
                masterGain.gain.linearRampToValueAtTime(v ? 0 : 0.6, ctx.currentTime + 0.05);
            }
        }

        function tone(freq, duration, opts) {
            const o = opts || {};
            const c = ensureCtx();
            if (!c) return;
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(freq, c.currentTime);
            if (o.bendTo) {
                osc.frequency.exponentialRampToValueAtTime(o.bendTo, c.currentTime + duration);
            }
            const peak = o.volume != null ? o.volume : 0.4;
            g.gain.setValueAtTime(0, c.currentTime);
            g.gain.linearRampToValueAtTime(peak, c.currentTime + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0008, c.currentTime + duration);
            osc.connect(g);
            g.connect(sfxGain);
            osc.start();
            osc.stop(c.currentTime + duration + 0.02);
        }

        function correct() {
            // C major triad up to high C.
            [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => {
                setTimeout(() => tone(f, 0.32, { type: 'triangle', volume: 0.35 }), i * 70);
            });
        }

        function wrong() {
            tone(196, 0.18, { type: 'sawtooth', volume: 0.22, bendTo: 130 });
        }

        function skip() {
            tone(440, 0.12, { type: 'triangle', volume: 0.25 });
            setTimeout(() => tone(330, 0.16, { type: 'triangle', volume: 0.22 }), 100);
        }

        function next() {
            tone(660, 0.08, { type: 'sine', volume: 0.22 });
        }

        function fanfare() {
            // Played on milestone streaks.
            [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach((f, i) => {
                setTimeout(() => tone(f, 0.28, { type: 'triangle', volume: 0.32 }), i * 90);
            });
        }

        // Ambient generative music: random pentatonic raindrops.
        const pentatonic = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99];

        function dropNote() {
            const c = ensureCtx();
            if (!c) return;
            const f = pentatonic[Math.floor(Math.random() * pentatonic.length)];
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            const now = c.currentTime;
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(0.09, now + 0.4);
            g.gain.exponentialRampToValueAtTime(0.0008, now + 2.8);
            osc.connect(g);
            g.connect(musicGain);
            osc.start(now);
            osc.stop(now + 3);
        }

        function scheduleNextDrop() {
            if (!musicTimer) return;
            dropNote();
            const delay = 700 + Math.random() * 900;
            musicTimer = setTimeout(scheduleNextDrop, delay);
        }

        function startMusic() {
            if (musicTimer) return;
            if (!ensureCtx()) return;
            musicTimer = true; // truthy sentinel before first setTimeout
            scheduleNextDrop();
        }

        function stopMusic() {
            if (musicTimer && musicTimer !== true) clearTimeout(musicTimer);
            musicTimer = null;
        }

        return {
            ensureCtx, setMuted,
            correct, wrong, skip, next, fanfare,
            startMusic, stopMusic
        };
    })();

    function applyMute() {
        muteButton.classList.toggle('muted', muted);
        muteButton.setAttribute('aria-pressed', String(muted));
        audio.setMuted(muted);
    }

    function toggleMute() {
        muted = !muted;
        applyMute();
        saveStore({ muted: muted });
        if (gameInitialized) {
            if (muted) audio.stopMusic();
            else audio.startMusic();
        }
    }

    // ---- Map ------------------------------------------------------------

    function defaultFeatureStyle() {
        return {
            fillColor: 'gray',
            strokeColor: 'black',
            strokeWeight: 1,
            fillOpacity: 0.5
        };
    }

    function loadGeojson() {
        if (!geojsonPromise) {
            geojsonPromise = fetch('custom.geo.json').then(response => {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }
        return geojsonPromise;
    }

    function initMap() {
        try {
            map = new google.maps.Map(document.getElementById("map"), {
                zoom: 2,
                center: { lat: 20, lng: 0 },
                gestureHandling: 'none',
                zoomControl: false,
                disableDefaultUI: true,
                draggable: false,
                keyboardShortcuts: false,
                styles: mapStyle
            });
            countryLayer = new google.maps.Data();
            countryLayer.setStyle(defaultFeatureStyle);
            countryLayer.setMap(map);

            loadGeojson()
                .then(geojsonData => countryLayer.addGeoJson(geojsonData))
                .catch(error => console.error('Error loading custom.geo.json:', error));
        } catch (error) {
            console.error('Error initializing map:', error);
            const mapElement = document.getElementById("map");
            if (mapElement) mapElement.innerText = "Map unavailable, but you can still play.";
        }
    }

    // ---- Country data ---------------------------------------------------

    function processFeatures(features) {
        const out = [];
        features.forEach(feature => {
            const p = (feature && feature.properties) || {};
            const name = p.name;
            const continentRaw = p.continent;
            if (!name || !continentRaw) return;
            if (skipContinents.has(continentRaw)) return;

            let iso2 = (p.iso_a2 || '').toLowerCase();
            if (!iso2 || iso2 === '-99') {
                iso2 = isoA2Override[name] || null;
            }
            if (!iso2) return;

            const continent = continentRename[continentRaw] || continentRaw;

            out.push({
                country: name,
                code: p.iso_a3 || null,
                continent: continent,
                flagUrl: 'https://flagcdn.com/' + iso2 + '.svg'
            });
        });
        return out;
    }

    function loadCountryData() {
        loadGeojson()
            .then(geojsonData => {
                const features = (geojsonData && geojsonData.features) || [];
                countryData = processFeatures(features);
                if (countryData.length === 0) {
                    countryDisplay.innerText = "No country data available.";
                    return;
                }
                startGame();
            })
            .catch(error => {
                console.error('Error loading country data:', error);
                countryDisplay.innerText = "Failed to load country data.";
            });
    }

    // ---- Queue / rounds -------------------------------------------------

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    function nextCountry() {
        if (queue.length === 0) {
            const indices = [];
            for (let i = 0; i < countryData.length; i++) indices.push(i);
            queue = shuffle(indices);
        }
        return countryData[queue.pop()];
    }

    function streakAnnotation(s) {
        if (s >= 20) return { label: ' — LEGENDARY!', cls: 'streak-legendary' };
        if (s >= 10) return { label: ' — BLAZING', cls: 'streak-blazing' };
        if (s >= 5)  return { label: ' — on fire', cls: 'streak-on-fire' };
        return null;
    }

    function updateScoreboard() {
        const note = streakAnnotation(streak);
        const base =
            'Score: ' + score + '/' + attempts +
            ' · Streak: ' + streak +
            ' (Best: ' + bestStreak + ')';
        if (note) {
            scoreboard.innerHTML =
                escapeHtml(base) +
                '<span class="' + note.cls + '">' + escapeHtml(note.label) + '</span>';
        } else {
            scoreboard.textContent = base;
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function animateOnce(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        // Force reflow so the animation restarts even if class was just added.
        void el.offsetWidth;
        el.classList.add(cls);
    }

    function startGame() {
        if (countryData.length === 0) {
            countryDisplay.innerText = "No country data available.";
            return;
        }
        resultDisplay.innerText = "";
        resultDisplay.style.color = "";
        clearCountryHighlight();
        resetButtons();
        nextButton.hidden = true;
        skipButton.disabled = false;
        firstTryWrong = false;

        currentCountry = nextCountry();
        attempts++;
        countryDisplay.innerText = "Which continent is " + currentCountry.country + " in?";
        countryFlag.src = currentCountry.flagUrl;
        countryFlag.alt = currentCountry.country + " Flag";
        countryFlag.hidden = false;
        animateOnce(countryFlag, 'entering');
        updateScoreboard();
    }

    function finishRound() {
        disableAllButtons();
        skipButton.disabled = true;
        highlightCountry(currentCountry);
        updateScoreboard();
        nextButton.hidden = false;
    }

    function checkAnswer(selectedContinent, button) {
        if (!currentCountry || !currentCountry.continent) return;

        if (selectedContinent === currentCountry.continent) {
            const wasFirstTry = !firstTryWrong;
            if (wasFirstTry) {
                score++;
                streak++;
                if (streak > bestStreak) {
                    bestStreak = streak;
                    saveStore({ bestStreak: bestStreak });
                }
            } else {
                streak = 0;
            }
            resultDisplay.innerText = "Correct!";
            resultDisplay.style.color = "green";
            button.classList.add('correct');
            animateOnce(countryFlag, 'pulse');
            playConfetti();
            const milestone = wasFirstTry && (streak === 5 || (streak >= 10 && streak % 10 === 0));
            if (milestone) {
                audio.fanfare();
                setTimeout(() => playConfetti({ spread: 100, particleCount: 140 }), 120);
            } else {
                audio.correct();
            }
            finishRound();
        } else {
            if (!firstTryWrong) {
                firstTryWrong = true;
                streak = 0;
                updateScoreboard();
            }
            resultDisplay.innerText = "Try again.";
            resultDisplay.style.color = "red";
            button.classList.add('incorrect');
            button.disabled = true;
            animateOnce(button, 'shake');
            audio.wrong();
        }
    }

    function skipCurrent() {
        if (!currentCountry || nextButton.hidden === false) return;
        if (!firstTryWrong) streak = 0;
        firstTryWrong = true;
        resultDisplay.innerText = "The answer is " + currentCountry.continent + ".";
        resultDisplay.style.color = "#444";
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(b => {
            if (b.innerText === currentCountry.continent) b.classList.add('correct');
        });
        audio.skip();
        finishRound();
    }

    function advance() {
        if (nextButton.hidden) return;
        audio.next();
        startGame();
    }

    function createButtons() {
        continentButtonsContainer.innerHTML = '';
        continents.forEach((continent, idx) => {
            const button = document.createElement("button");
            button.type = "button";
            button.classList.add("continent-button");
            button.innerText = continent;
            button.title = continent + ' (' + (idx + 1) + ')';
            button.addEventListener('click', () => checkAnswer(continent, button));
            continentButtonsContainer.appendChild(button);
        });
    }

    function resetButtons() {
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(button => {
            button.disabled = false;
            button.classList.remove('incorrect', 'correct', 'shake', 'pulse');
        });
    }

    function disableAllButtons() {
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(button => { button.disabled = true; });
    }

    function highlightCountry(country) {
        if (!countryLayer || !country) return;

        const targetCode = country.code ? country.code.toUpperCase() : null;
        const targetName = country.country ? country.country.toLowerCase() : null;

        countryLayer.setStyle(function (feature) {
            const featureCode = feature.getProperty('iso_a3');
            const featureName = feature.getProperty('name');
            const codeMatch = targetCode && featureCode && featureCode.toUpperCase() === targetCode;
            const nameMatch = targetName && featureName && featureName.toLowerCase() === targetName;
            if (codeMatch || nameMatch) {
                return {
                    fillColor: 'yellow',
                    strokeColor: 'black',
                    strokeWeight: 1,
                    fillOpacity: 0.8
                };
            }
            return defaultFeatureStyle();
        });
    }

    function clearCountryHighlight() {
        if (!countryLayer) return;
        countryLayer.setStyle(defaultFeatureStyle);
    }

    function playConfetti(opts) {
        if (typeof confetti !== 'function') return;
        const options = Object.assign({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
        }, opts || {});
        confetti(options);
    }

    function initializeGame() {
        if (gameInitialized) return;
        gameInitialized = true;
        createButtons();
        loadCountryData();
    }

    // ---- Keyboard shortcuts --------------------------------------------

    function isTypingTarget(target) {
        if (!target) return false;
        const tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
    }

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;

        if (e.key === 'm' || e.key === 'M') {
            toggleMute();
            e.preventDefault();
            return;
        }

        // Splash screen: Enter or Space to start.
        if (gameContainer.style.display !== 'block') {
            if (e.key === 'Enter' || e.key === ' ') {
                startButton.click();
                e.preventDefault();
            }
            return;
        }

        // Game running.
        if (e.key === 'Enter' || e.key === ' ') {
            if (!nextButton.hidden) {
                advance();
                e.preventDefault();
            }
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            if (!skipButton.disabled) {
                skipCurrent();
                e.preventDefault();
            }
            return;
        }
        if (/^[1-7]$/.test(e.key)) {
            const idx = parseInt(e.key, 10) - 1;
            const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
            const btn = buttons[idx];
            if (btn && !btn.disabled) {
                checkAnswer(continents[idx], btn);
                e.preventDefault();
            }
        }
    });

    // ---- Wire up --------------------------------------------------------

    countryFlag.addEventListener('error', () => {
        countryFlag.hidden = true;
    });

    muteButton.addEventListener('click', toggleMute);

    startButton.addEventListener('click', () => {
        splashScreen.classList.add('fading');
        setTimeout(() => { splashScreen.style.display = 'none'; }, 400);
        gameContainer.style.display = 'block';
        audio.ensureCtx();
        if (!muted) audio.startMusic();
        initializeGame();
    });

    skipButton.addEventListener('click', skipCurrent);
    nextButton.addEventListener('click', advance);

    applyMute();

    // Google Maps loads with ?callback=initMap and expects a global.
    window.initMap = initMap;
})();
