(function () {
    'use strict';

    const STORE_KEY = 'geography-game-state-v2';

    const continents = ["Africa", "Asia", "Europe", "North America", "South America", "Australia", "Antarctica"];

    const continentRename = { 'Oceania': 'Australia' };
    const skipContinents = new Set(['Seven seas (open ocean)']);

    // Natural Earth sets iso_a2/iso_a3 to "-99" for a few features.
    const isoA2Override = { 'France': 'fr', 'Norway': 'no', 'Kosovo': 'xk' };
    const isoA3Override = { 'France': 'FRA', 'Norway': 'NOR', 'Kosovo': 'KOS' };

    const CAPITALS = window.CAPITALS || {};
    const allCapitals = Object.keys(CAPITALS).map(k => CAPITALS[k]);

    // Map palette.
    const LAND_COLOR = '#f6c971';
    const LAND_STROKE = '#a86a2c';
    const HIGHLIGHT_COLOR = '#e63946';
    const HIGHLIGHT_STROKE = '#ffffff';
    const WATER_COLOR = '#74c0e3';

    const mapStyle = [
        { elementType: "labels", stylers: [{ visibility: "off" }] },
        { featureType: "water",          elementType: "geometry", stylers: [{ color: WATER_COLOR }] },
        { featureType: "landscape",      elementType: "geometry", stylers: [{ color: LAND_COLOR }] },
        { featureType: "road",           stylers: [{ visibility: "off" }] },
        { featureType: "poi",            stylers: [{ visibility: "off" }] },
        { featureType: "transit",        stylers: [{ visibility: "off" }] },
        { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] }
    ];

    // DOM
    const countryDisplay = document.getElementById("country");
    const countryFlag = document.getElementById("country-flag");
    const resultDisplay = document.getElementById("result");
    const continentContainer = document.getElementById("continent-buttons");
    const capitalContainer = document.getElementById("capital-buttons");
    const skipButton = document.getElementById("skip-button");
    const capitalButton = document.getElementById("capital-button");
    const nextButton = document.getElementById("next-button");
    const splashScreen = document.getElementById("splash-screen");
    const startButton = document.getElementById("start-button");
    const gameContainer = document.getElementById("game-container");
    const settingsButton = document.getElementById("settings-button");
    const settingsPanel = document.getElementById("settings-panel");
    const toggleMusicEl = document.getElementById("toggle-music");
    const toggleSfxEl = document.getElementById("toggle-sfx");
    const streakRollerEl = document.getElementById("streak-roller");
    const totalRollerEl = document.getElementById("total-roller");

    // State
    let countryData = [];
    let queue = [];
    let currentCountry = null;
    let map = null;
    let countryLayer = null;
    let geojsonPromise = null;
    let gameInitialized = false;
    let phase = 'continent';        // 'continent' | 'capital' | 'done'
    let firstTryWrong = false;
    let streak = 0;
    let total = 0;

    // ---- Persistent state -----------------------------------------------

    function loadStore() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) { return {}; }
    }

    function saveStore(patch) {
        try {
            const next = Object.assign({}, loadStore(), patch);
            localStorage.setItem(STORE_KEY, JSON.stringify(next));
        } catch (e) { /* ignore */ }
    }

    const persisted = loadStore();
    total = typeof persisted.total === 'number' ? persisted.total : 0;
    let musicEnabled = persisted.musicEnabled !== false;
    let sfxEnabled = persisted.sfxEnabled !== false;

    // ---- Audio engine (Web Audio synth) ---------------------------------

    const audio = (function () {
        let ctx = null;
        let masterGain = null;
        let musicGain = null;
        let sfxGain = null;
        let musicTimer = null;

        function ensureCtx() {
            if (!ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                try { ctx = new AC(); } catch (e) { return null; }
                masterGain = ctx.createGain();
                masterGain.gain.value = 0.6;
                masterGain.connect(ctx.destination);
                musicGain = ctx.createGain();
                musicGain.gain.value = musicEnabled ? 0.18 : 0;
                musicGain.connect(masterGain);
                sfxGain = ctx.createGain();
                sfxGain.gain.value = sfxEnabled ? 0.55 : 0;
                sfxGain.connect(masterGain);
            }
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                ctx.resume().catch(() => {});
            }
            return ctx;
        }

        async function unlock() {
            const c = ensureCtx();
            if (!c) return;
            if (c.state === 'suspended') {
                try { await c.resume(); } catch (e) { /* ignore */ }
            }
            try {
                const buf = c.createBuffer(1, 1, 22050);
                const src = c.createBufferSource();
                src.buffer = buf;
                src.connect(c.destination);
                src.start(0);
            } catch (e) { /* ignore */ }
        }

        function ramp(gainNode, value) {
            if (gainNode && ctx) {
                gainNode.gain.cancelScheduledValues(ctx.currentTime);
                gainNode.gain.linearRampToValueAtTime(value, ctx.currentTime + 0.05);
            }
        }

        function setMusicEnabled(on) { ramp(musicGain, on ? 0.18 : 0); }
        function setSfxEnabled(on) { ramp(sfxGain, on ? 0.55 : 0); }

        function tone(freq, duration, opts) {
            const o = opts || {};
            const c = ensureCtx();
            if (!c) return;
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(freq, c.currentTime);
            if (o.bendTo) osc.frequency.exponentialRampToValueAtTime(o.bendTo, c.currentTime + duration);
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
            [523.25, 659.25, 783.99, 1046.50].forEach((f, i) =>
                setTimeout(() => tone(f, 0.32, { type: 'triangle', volume: 0.35 }), i * 70));
        }
        function wrong() { tone(196, 0.18, { type: 'sawtooth', volume: 0.22, bendTo: 130 }); }
        function skip() {
            tone(440, 0.12, { type: 'triangle', volume: 0.25 });
            setTimeout(() => tone(330, 0.16, { type: 'triangle', volume: 0.22 }), 100);
        }
        function next() { tone(660, 0.08, { type: 'sine', volume: 0.22 }); }
        function fanfare() {
            [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach((f, i) =>
                setTimeout(() => tone(f, 0.28, { type: 'triangle', volume: 0.32 }), i * 90));
        }

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
            musicTimer = setTimeout(scheduleNextDrop, 700 + Math.random() * 900);
        }

        function startMusic() {
            if (musicTimer) return;
            if (!ensureCtx()) return;
            musicTimer = true;
            scheduleNextDrop();
        }

        function stopMusic() {
            if (musicTimer && musicTimer !== true) clearTimeout(musicTimer);
            musicTimer = null;
        }

        return {
            ensureCtx, unlock, setMusicEnabled, setSfxEnabled,
            correct, wrong, skip, next, fanfare, startMusic, stopMusic
        };
    })();

    // ---- Settings -------------------------------------------------------

    function syncSettingsUI() {
        toggleMusicEl.checked = musicEnabled;
        toggleSfxEl.checked = sfxEnabled;
    }

    function openSettings() {
        settingsPanel.hidden = false;
        settingsButton.setAttribute('aria-expanded', 'true');
    }
    function closeSettings() {
        settingsPanel.hidden = true;
        settingsButton.setAttribute('aria-expanded', 'false');
    }
    function toggleSettings() {
        if (settingsPanel.hidden) openSettings(); else closeSettings();
    }

    function setMusic(on) {
        musicEnabled = on;
        saveStore({ musicEnabled: on });
        audio.setMusicEnabled(on);
        if (gameInitialized) {
            if (on) audio.startMusic(); else audio.stopMusic();
        }
        syncSettingsUI();
    }

    function setSfx(on) {
        sfxEnabled = on;
        saveStore({ sfxEnabled: on });
        audio.setSfxEnabled(on);
        syncSettingsUI();
    }

    // ---- Map ------------------------------------------------------------

    function defaultFeatureStyle() {
        return { fillColor: LAND_COLOR, strokeColor: LAND_STROKE, strokeWeight: 0.8, fillOpacity: 1 };
    }

    function loadGeojson() {
        if (!geojsonPromise) {
            geojsonPromise = fetch('custom.geo.json').then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
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
                backgroundColor: WATER_COLOR,
                styles: mapStyle
            });
            countryLayer = new google.maps.Data();
            countryLayer.setStyle(defaultFeatureStyle);
            countryLayer.setMap(map);
            loadGeojson()
                .then(geo => countryLayer.addGeoJson(geo))
                .catch(err => console.error('Error loading custom.geo.json:', err));
        } catch (error) {
            console.error('Error initializing map:', error);
            const el = document.getElementById("map");
            if (el) el.innerText = "Map unavailable, but you can still play.";
        }
    }

    function highlightCountry(country) {
        if (!countryLayer || !country) return;
        const targetCode = country.code ? country.code.toUpperCase() : null;
        const targetName = country.country ? country.country.toLowerCase() : null;
        countryLayer.setStyle(function (feature) {
            const fCode = feature.getProperty('iso_a3');
            const fName = feature.getProperty('name');
            const codeMatch = targetCode && fCode && fCode.toUpperCase() === targetCode;
            const nameMatch = targetName && fName && fName.toLowerCase() === targetName;
            if (codeMatch || nameMatch) {
                return { fillColor: HIGHLIGHT_COLOR, strokeColor: HIGHLIGHT_STROKE, strokeWeight: 2, fillOpacity: 1, zIndex: 2 };
            }
            return defaultFeatureStyle();
        });
    }

    function clearCountryHighlight() {
        if (!countryLayer) return;
        countryLayer.setStyle(defaultFeatureStyle);
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
            if (!iso2 || iso2 === '-99') iso2 = isoA2Override[name] || null;
            if (!iso2) return;

            let iso3 = p.iso_a3;
            if (!iso3 || iso3 === '-99') iso3 = isoA3Override[name] || null;

            out.push({
                country: name,
                code: iso3,
                continent: continentRename[continentRaw] || continentRaw,
                flagUrl: 'https://flagcdn.com/' + iso2 + '.svg'
            });
        });
        return out;
    }

    function loadCountryData() {
        loadGeojson()
            .then(geo => {
                countryData = processFeatures((geo && geo.features) || []);
                if (countryData.length === 0) {
                    countryDisplay.innerText = "No country data available.";
                    return;
                }
                startGame();
            })
            .catch(err => {
                console.error('Error loading country data:', err);
                countryDisplay.innerText = "Failed to load country data.";
            });
    }

    function capitalFor(country) {
        return (country && country.code && CAPITALS[country.code]) || null;
    }

    // ---- Rollers --------------------------------------------------------

    function createDigitSlot(initialDigit) {
        const slot = document.createElement('div');
        slot.className = 'roller-digit';
        const roll = document.createElement('div');
        roll.className = 'digit-roll';
        for (let i = 0; i <= 9; i++) {
            const s = document.createElement('span');
            s.textContent = i;
            roll.appendChild(s);
        }
        roll.style.transition = 'none';
        roll.style.transform = 'translateY(-' + (initialDigit * 1.2) + 'em)';
        slot.appendChild(roll);
        return slot;
    }

    function setRoller(rollerEl, value) {
        const str = String(Math.max(0, Math.floor(value)));
        const digits = str.split('').map(Number);
        if (rollerEl.children.length !== digits.length) {
            rollerEl.innerHTML = '';
            const created = digits.map(d => {
                const slot = createDigitSlot(d);
                rollerEl.appendChild(slot);
                return slot;
            });
            void rollerEl.offsetHeight;
            created.forEach(slot => { slot.querySelector('.digit-roll').style.transition = ''; });
        } else {
            digits.forEach((d, i) => {
                rollerEl.children[i].querySelector('.digit-roll').style.transform =
                    'translateY(-' + (d * 1.2) + 'em)';
            });
        }
    }

    function streakClass(s) {
        if (s >= 20) return 'streak-legendary';
        if (s >= 10) return 'streak-blazing';
        if (s >= 5)  return 'streak-on-fire';
        return '';
    }

    function updateCounters() {
        setRoller(streakRollerEl, streak);
        setRoller(totalRollerEl, total);
        streakRollerEl.classList.remove('streak-on-fire', 'streak-blazing', 'streak-legendary');
        const cls = streakClass(streak);
        if (cls) streakRollerEl.classList.add(cls);
    }

    // ---- Round flow -----------------------------------------------------

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }

    function nextCountry() {
        if (queue.length === 0) {
            const idx = [];
            for (let i = 0; i < countryData.length; i++) idx.push(i);
            queue = shuffle(idx);
        }
        return countryData[queue.pop()];
    }

    function animateOnce(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
    }

    function resetChoiceButtons(container) {
        container.querySelectorAll('.choice-button').forEach(b => {
            b.disabled = false;
            b.classList.remove('incorrect', 'correct', 'shake', 'pulse');
        });
    }

    function disableChoiceButtons(container) {
        container.querySelectorAll('.choice-button').forEach(b => { b.disabled = true; });
    }

    function startGame() {
        if (countryData.length === 0) {
            countryDisplay.innerText = "No country data available.";
            return;
        }
        phase = 'continent';
        firstTryWrong = false;

        resultDisplay.innerText = "";
        resultDisplay.style.color = "";
        clearCountryHighlight();

        capitalContainer.hidden = true;
        capitalContainer.innerHTML = '';
        continentContainer.hidden = false;
        resetChoiceButtons(continentContainer);

        skipButton.hidden = false;
        skipButton.disabled = false;
        capitalButton.hidden = true;
        nextButton.hidden = true;

        currentCountry = nextCountry();
        countryDisplay.innerText = "Which continent is " + currentCountry.country + " in?";
        countryFlag.src = currentCountry.flagUrl;
        countryFlag.alt = currentCountry.country + " Flag";
        countryFlag.hidden = false;
        animateOnce(countryFlag, 'entering');
        updateCounters();
    }

    function finishContinent() {
        phase = 'done';
        disableChoiceButtons(continentContainer);
        skipButton.hidden = true;
        highlightCountry(currentCountry);
        // Offer capital round if we know the capital.
        capitalButton.hidden = !capitalFor(currentCountry);
        nextButton.hidden = false;
        updateCounters();
    }

    function checkContinent(selected, button) {
        if (phase !== 'continent' || !currentCountry) return;

        if (selected === currentCountry.continent) {
            const firstTry = !firstTryWrong;
            total += 1;
            saveStore({ total: total });
            if (firstTry) {
                streak += 1;
            } else {
                streak = 0;
            }
            resultDisplay.innerText = "Correct!";
            resultDisplay.style.color = "#0f9d6b";
            button.classList.add('correct');
            animateOnce(countryFlag, 'pulse');
            playConfetti();
            const milestone = firstTry && (streak === 5 || (streak >= 10 && streak % 10 === 0));
            if (milestone) {
                audio.fanfare();
                setTimeout(() => playConfetti({ spread: 100, particleCount: 140 }), 120);
            } else {
                audio.correct();
            }
            finishContinent();
        } else {
            if (!firstTryWrong) {
                firstTryWrong = true;
                streak = 0;
                updateCounters();
            }
            resultDisplay.innerText = "Try again.";
            resultDisplay.style.color = "#e11d48";
            button.classList.add('incorrect');
            button.disabled = true;
            animateOnce(button, 'shake');
            audio.wrong();
        }
    }

    function skipCurrent() {
        if (phase !== 'continent' || !currentCountry || skipButton.hidden) return;
        streak = 0;
        firstTryWrong = true;
        resultDisplay.innerText = "It's in " + currentCountry.continent + ".";
        resultDisplay.style.color = "#5b6b7b";
        continentContainer.querySelectorAll('.choice-button').forEach(b => {
            if (b.innerText === currentCountry.continent) b.classList.add('correct');
        });
        audio.skip();
        finishContinent();
    }

    function startCapitalRound() {
        const correct = capitalFor(currentCountry);
        if (!correct) return;
        phase = 'capital';

        countryDisplay.innerText = "What is the capital of " + currentCountry.country + "?";
        capitalButton.hidden = true;
        nextButton.hidden = true;
        skipButton.hidden = true;
        continentContainer.hidden = true;

        const pool = allCapitals.filter(c => c !== correct);
        shuffle(pool);
        const options = shuffle(pool.slice(0, 3).concat([correct]));

        capitalContainer.innerHTML = '';
        options.forEach(cap => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'choice-button capital-choice';
            b.innerText = cap;
            b.addEventListener('click', () => checkCapital(cap, b, correct));
            capitalContainer.appendChild(b);
        });
        capitalContainer.hidden = false;
        resultDisplay.innerText = "";
        resultDisplay.style.color = "";
    }

    function checkCapital(selected, button, correct) {
        if (phase !== 'capital') return;
        disableChoiceButtons(capitalContainer);

        if (selected === correct) {
            total += 1;
            saveStore({ total: total });
            resultDisplay.innerText = "Correct!";
            resultDisplay.style.color = "#0f9d6b";
            button.classList.add('correct');
            playConfetti();
            audio.correct();
        } else {
            resultDisplay.innerText = "The capital is " + correct + ".";
            resultDisplay.style.color = "#e11d48";
            button.classList.add('incorrect');
            animateOnce(button, 'shake');
            capitalContainer.querySelectorAll('.choice-button').forEach(b => {
                if (b.innerText === correct) b.classList.add('correct');
            });
            audio.wrong();
        }
        phase = 'done';
        nextButton.hidden = false;
        updateCounters();
    }

    function advance() {
        if (nextButton.hidden) return;
        audio.next();
        startGame();
    }

    function createContinentButtons() {
        continentContainer.innerHTML = '';
        continents.forEach((continent, idx) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "choice-button";
            button.innerText = continent;
            button.title = continent + ' (' + (idx + 1) + ')';
            button.addEventListener('click', () => checkContinent(continent, button));
            continentContainer.appendChild(button);
        });
    }

    function playConfetti(opts) {
        if (typeof confetti !== 'function') return;
        confetti(Object.assign({ particleCount: 100, spread: 70, origin: { y: 0.6 } }, opts || {}));
    }

    function initializeGame() {
        if (gameInitialized) return;
        gameInitialized = true;
        createContinentButtons();
        updateCounters();
        loadCountryData();
    }

    // ---- Keyboard -------------------------------------------------------

    function isTypingTarget(t) {
        if (!t) return false;
        return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    }

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;

        if (e.key === 'Escape' && !settingsPanel.hidden) { closeSettings(); return; }

        if (!gameContainer.classList.contains('active')) {
            if (e.key === 'Enter' || e.key === ' ') { startButton.click(); e.preventDefault(); }
            return;
        }

        if (e.key === 'Enter' || e.key === ' ') {
            if (!nextButton.hidden) { advance(); e.preventDefault(); }
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            if (!skipButton.hidden && !skipButton.disabled) { skipCurrent(); e.preventDefault(); }
            return;
        }
        if (e.key === 'c' || e.key === 'C') {
            if (!capitalButton.hidden) { startCapitalRound(); e.preventDefault(); }
            return;
        }
        if (/^[1-9]$/.test(e.key)) {
            const idx = parseInt(e.key, 10) - 1;
            if (phase === 'continent') {
                const btns = continentContainer.querySelectorAll('.choice-button');
                if (btns[idx] && !btns[idx].disabled) { checkContinent(continents[idx], btns[idx]); e.preventDefault(); }
            } else if (phase === 'capital') {
                const btns = capitalContainer.querySelectorAll('.choice-button');
                if (btns[idx] && !btns[idx].disabled) { btns[idx].click(); e.preventDefault(); }
            }
        }
    });

    // ---- Wire up --------------------------------------------------------

    countryFlag.addEventListener('error', () => { countryFlag.hidden = true; });

    settingsButton.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
    settingsPanel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!settingsPanel.hidden) closeSettings(); });
    toggleMusicEl.addEventListener('change', () => setMusic(toggleMusicEl.checked));
    toggleSfxEl.addEventListener('change', () => setSfx(toggleSfxEl.checked));

    startButton.addEventListener('click', async () => {
        splashScreen.classList.add('fading');
        setTimeout(() => { splashScreen.style.display = 'none'; }, 400);
        gameContainer.classList.add('active');
        await audio.unlock();
        if (musicEnabled) audio.startMusic();
        initializeGame();
    });

    skipButton.addEventListener('click', skipCurrent);
    capitalButton.addEventListener('click', startCapitalRound);
    nextButton.addEventListener('click', advance);

    syncSettingsUI();

    // Google Maps loads with ?callback=initMap and expects a global.
    window.initMap = initMap;
})();
