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

    // Equirectangular world map rendered as inline SVG from the GeoJSON —
    // no external map provider, so it always renders (no API key/billing).
    // Colours are set as SVG presentation attributes (not CSS classes) so
    // the map renders even if the stylesheet is cached/stale or classList
    // misbehaves on older mobile browsers.
    const MAP_W = 360;
    const MAP_H = 180;
    const LAND_FILL = '#f6c971';
    const LAND_STROKE = '#a86a2c';
    const HILITE_FILL = '#e63946';
    const HILITE_STROKE = '#ffffff';
    let svgPaths = [];

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
    const resetButton = document.getElementById("reset-button");
    const streakRollerEl = document.getElementById("streak-roller");
    const totalRollerEl = document.getElementById("total-roller");

    // State
    let countryData = [];
    let queue = [];
    let currentCountry = null;
    let geojsonPromise = null;
    let gameInitialized = false;
    let phase = 'continent';        // 'continent' | 'capital' | 'done'
    let firstTryWrong = false;
    let streak = 0;
    let total = 0;

    // Visibility helpers — use inline display so we never depend on the
    // [hidden] attribute fighting a CSS `display` rule (the bug that left
    // the continent buttons on screen during the capital round).
    function showEl(el) { if (el) { el.removeAttribute('hidden'); el.style.display = ''; } }
    function hideEl(el) { if (el) { el.style.display = 'none'; } }
    function isHidden(el) { return !el || el.style.display === 'none'; }

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
                musicGain.gain.value = musicEnabled ? 0.3 : 0;
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

        function setMusicEnabled(on) { ramp(musicGain, on ? 0.3 : 0); }
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

        // Lively looping tune: an upbeat I–V–vi–IV progression (C–G–Am–F)
        // with a plucky bass, soft pad, and a bright arpeggio lead.
        const TEMPO = 116;
        const STEP = 60 / TEMPO / 2;          // eighth-note duration
        const STEPS_PER_BAR = 8;
        const BARS = 4;
        const TOTAL_STEPS = STEPS_PER_BAR * BARS;
        const progression = [
            { bass: 65.41,  triad: [261.63, 329.63, 392.00] }, // C
            { bass: 98.00,  triad: [196.00, 246.94, 293.66] }, // G
            { bass: 110.00, triad: [220.00, 261.63, 329.63] }, // Am
            { bass: 87.31,  triad: [174.61, 220.00, 261.63] }  // F
        ];
        let step = 0;
        let nextNoteTime = 0;

        function voice(freq, when, dur, type, vol) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            g.gain.setValueAtTime(0, when);
            g.gain.linearRampToValueAtTime(vol, when + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
            osc.connect(g);
            g.connect(musicGain);
            osc.start(when);
            osc.stop(when + dur + 0.02);
        }

        function scheduleStep(stepIndex, when) {
            const bar = Math.floor(stepIndex / STEPS_PER_BAR) % BARS;
            const beat = stepIndex % STEPS_PER_BAR;
            const chord = progression[bar];
            if (beat === 0 || beat === 4) {
                voice(chord.bass, when, 0.42, 'triangle', 0.20);          // bass
            }
            if (beat === 0) {
                chord.triad.forEach(f => voice(f, when, STEP * 8 * 0.95, 'sine', 0.045)); // pad
            }
            const arp = chord.triad[beat % 3] * 2;
            voice(arp, when, STEP * 0.9, 'triangle', 0.075);              // lead
        }

        function musicScheduler() {
            if (!musicTimer) return;
            while (nextNoteTime < ctx.currentTime + 0.12) {
                scheduleStep(step, nextNoteTime);
                nextNoteTime += STEP;
                step = (step + 1) % TOTAL_STEPS;
            }
            musicTimer = setTimeout(musicScheduler, 25);
        }

        function startMusic() {
            if (musicTimer) return;
            if (!ensureCtx()) return;
            step = 0;
            nextNoteTime = ctx.currentTime + 0.1;
            musicTimer = true;
            musicScheduler();
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

    function resetProgress() {
        if (!window.confirm('Reset your streak and total to zero?')) return;
        streak = 0;
        total = 0;
        saveStore({ total: 0 });
        updateCounters();
        closeSettings();
    }

    // ---- Map (self-rendered SVG world) ----------------------------------

    function loadGeojson() {
        if (!geojsonPromise) {
            geojsonPromise = fetch('custom.geo.json').then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
        }
        return geojsonPromise;
    }

    function ringToPath(ring) {
        let d = '';
        for (let i = 0; i < ring.length; i++) {
            const lon = ring[i][0];
            const lat = ring[i][1];
            const x = (lon + 180);
            const y = (90 - lat);
            d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
        }
        return d + 'Z';
    }

    function geometryToPath(geom) {
        if (!geom) return '';
        let polys;
        if (geom.type === 'Polygon') polys = [geom.coordinates];
        else if (geom.type === 'MultiPolygon') polys = geom.coordinates;
        else return '';
        let d = '';
        for (let i = 0; i < polys.length; i++) {
            for (let j = 0; j < polys[i].length; j++) {
                d += ringToPath(polys[i][j]);
            }
        }
        return d;
    }

    function buildMap(features) {
        const mapEl = document.getElementById('map');
        if (!mapEl) return;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + MAP_W + ' ' + MAP_H);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('class', 'map-svg');
        svg.style.display = 'block';

        svgPaths = [];
        features.forEach(feature => {
            const p = (feature && feature.properties) || {};
            if (p.continent === 'Seven seas (open ocean)') return;
            const d = geometryToPath(feature.geometry);
            if (!d) return;
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', LAND_FILL);
            path.setAttribute('stroke', LAND_STROKE);
            path.setAttribute('stroke-width', '0.4');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
            svgPaths.push({
                el: path,
                code: (p.iso_a3 && p.iso_a3 !== '-99') ? p.iso_a3.toUpperCase() : null,
                name: (p.name || '').toLowerCase()
            });
        });

        mapEl.textContent = '';
        mapEl.appendChild(svg);
    }

    function highlightCountry(country) {
        if (!country) return;
        const code = country.code ? country.code.toUpperCase() : null;
        const name = country.country ? country.country.toLowerCase() : null;
        svgPaths.forEach(p => {
            const match = (code && p.code === code) || (name && p.name === name);
            p.el.setAttribute('fill', match ? HILITE_FILL : LAND_FILL);
            p.el.setAttribute('stroke', match ? HILITE_STROKE : LAND_STROKE);
            p.el.setAttribute('stroke-width', match ? '0.9' : '0.4');
        });
    }

    function clearCountryHighlight() {
        svgPaths.forEach(p => {
            p.el.setAttribute('fill', LAND_FILL);
            p.el.setAttribute('stroke', LAND_STROKE);
            p.el.setAttribute('stroke-width', '0.4');
        });
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
                const features = (geo && geo.features) || [];
                countryData = processFeatures(features);
                buildMap(features);
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

        hideEl(capitalContainer);
        capitalContainer.innerHTML = '';
        showEl(continentContainer);
        resetChoiceButtons(continentContainer);

        showEl(skipButton);
        skipButton.disabled = false;
        hideEl(capitalButton);
        hideEl(nextButton);

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
        hideEl(skipButton);
        highlightCountry(currentCountry);
        // Offer capital round if we know the capital.
        if (capitalFor(currentCountry)) showEl(capitalButton); else hideEl(capitalButton);
        showEl(nextButton);
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
        if (phase !== 'continent' || !currentCountry || isHidden(skipButton)) return;
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
        hideEl(capitalButton);
        hideEl(nextButton);
        hideEl(skipButton);
        hideEl(continentContainer);

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
        showEl(capitalContainer);
        resultDisplay.innerText = "";
        resultDisplay.style.color = "";
    }

    function checkCapital(selected, button, correct) {
        if (phase !== 'capital') return;
        disableChoiceButtons(capitalContainer);

        if (selected === correct) {
            total += 2; // capitals are worth two points
            saveStore({ total: total });
            resultDisplay.innerText = "Correct! +2";
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
        showEl(nextButton);
        updateCounters();
    }

    function advance() {
        if (isHidden(nextButton)) return;
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
            if (!isHidden(nextButton)) { advance(); e.preventDefault(); }
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            if (!isHidden(skipButton) && !skipButton.disabled) { skipCurrent(); e.preventDefault(); }
            return;
        }
        if (e.key === 'c' || e.key === 'C') {
            if (!isHidden(capitalButton)) { startCapitalRound(); e.preventDefault(); }
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
    resetButton.addEventListener('click', resetProgress);

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
})();
