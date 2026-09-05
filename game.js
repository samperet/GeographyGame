(function () {
    'use strict';

    // Same key as before so existing totals survive the redesign.
    const STORE_KEY = 'geography-game-state-v2';

    const continents = ["Africa", "Asia", "Europe", "North America", "South America", "Australia", "Antarctica"];

    const continentRename = { 'Oceania': 'Australia' };
    const skipContinents = new Set(['Seven seas (open ocean)']);

    // Natural Earth sets iso_a2/iso_a3 to "-99" for a few features.
    const isoA2Override = { 'France': 'fr', 'Norway': 'no', 'Kosovo': 'xk' };
    const isoA3Override = { 'France': 'FRA', 'Norway': 'NOR', 'Kosovo': 'KOS' };

    const CAPITALS = window.CAPITALS || {};
    const allCapitals = Object.keys(CAPITALS).map(k => CAPITALS[k]);

    const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // ---- DOM --------------------------------------------------------------

    const $ = id => document.getElementById(id);
    const countryDisplay = $("country");
    const countryFlag = $("country-flag");
    const resultDisplay = $("result");
    const continentContainer = $("continent-buttons");
    const capitalContainer = $("capital-buttons");
    const skipButton = $("skip-button");
    const capitalButton = $("capital-button");
    const nextButton = $("next-button");
    const splashScreen = $("splash-screen");
    const startButton = $("start-button");
    const gameContainer = $("game-container");
    const settingsButton = $("settings-button");
    const settingsPanel = $("settings-panel");
    const toggleMusicEl = $("toggle-music");
    const toggleSfxEl = $("toggle-sfx");
    const fullscreenButton = $("fullscreen-button");
    const resetButton = $("reset-button");
    const streakRollerEl = $("streak-roller");
    const bestRollerEl = $("best-roller");
    const totalRollerEl = $("total-roller");
    const bannerEl = $("banner");
    const bannerText = $("banner-text");
    const captionEl = $("globe-caption");
    const captionFlag = $("caption-flag");
    const captionName = $("caption-name");
    const captionDetail = $("caption-detail");

    // ---- State ------------------------------------------------------------

    let countryData = [];
    let queue = [];
    let currentCountry = null;
    let geojsonPromise = null;
    let gameInitialized = false;
    let gameStarted = false;
    let phase = 'continent';        // 'continent' | 'capital' | 'done'
    let firstTryWrong = false;
    let streak = 0;
    let total = 0;
    let best = 0;

    // Visibility helpers — set both the attribute and an inline display so we
    // never depend on a stale stylesheet.
    function showEl(el) { if (el) { el.hidden = false; el.removeAttribute('hidden'); el.style.display = ''; } }
    function hideEl(el) { if (el) { el.hidden = true; el.style.display = 'none'; } }
    function isHidden(el) { return !el || el.hidden || el.style.display === 'none'; }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    // ---- Persistent state -------------------------------------------------

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
    best = typeof persisted.best === 'number' ? persisted.best : 0;
    let musicEnabled = persisted.musicEnabled !== false;
    let sfxEnabled = persisted.sfxEnabled !== false;

    // ---- Audio engine (Web Audio synth — no sound files needed) ----------

    const audio = (function () {
        const MUSIC_VOL = 0.22;
        const SFX_VOL = 0.65;
        let ctx = null;
        let master = null;
        let musicBus = null;
        let sfxBus = null;
        let noiseBuffer = null;
        let musicTimer = null;
        let duckTimer = null;

        function ensureCtx() {
            if (!ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                try { ctx = new AC(); } catch (e) { return null; }
                master = ctx.createGain();
                master.gain.value = 0.8;
                let out = master;
                if (typeof ctx.createDynamicsCompressor === 'function') {
                    const comp = ctx.createDynamicsCompressor();
                    comp.threshold.value = -14;
                    comp.knee.value = 18;
                    comp.ratio.value = 4;
                    comp.attack.value = 0.004;
                    comp.release.value = 0.2;
                    master.connect(comp);
                    out = comp;
                }
                out.connect(ctx.destination);
                musicBus = ctx.createGain();
                musicBus.gain.value = musicEnabled ? MUSIC_VOL : 0;
                musicBus.connect(master);
                sfxBus = ctx.createGain();
                sfxBus.gain.value = sfxEnabled ? SFX_VOL : 0;
                sfxBus.connect(master);
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

        function noiseBuf() {
            if (!noiseBuffer) {
                const len = Math.floor(ctx.sampleRate * 2);
                noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
                const d = noiseBuffer.getChannelData(0);
                for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            }
            return noiseBuffer;
        }

        function ramp(gainNode, value, secs) {
            if (gainNode && ctx) {
                gainNode.gain.cancelScheduledValues(ctx.currentTime);
                gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
                gainNode.gain.linearRampToValueAtTime(value, ctx.currentTime + (secs || 0.06));
            }
        }

        function setMusicEnabled(on) { ramp(musicBus, on ? MUSIC_VOL : 0); }
        function setSfxEnabled(on) { ramp(sfxBus, on ? SFX_VOL : 0); }

        // Briefly lower the music so a fanfare can shine.
        function duck(secs) {
            if (!musicBus || !musicEnabled) return;
            ramp(musicBus, MUSIC_VOL * 0.35, 0.08);
            if (duckTimer) clearTimeout(duckTimer);
            duckTimer = setTimeout(() => { if (musicEnabled) ramp(musicBus, MUSIC_VOL, 0.6); }, (secs || 1.2) * 1000);
        }

        // o: { freq, type, dur, vol, at, bendTo, attack, detune, lp, bus }
        function tone(o) {
            const c = ensureCtx();
            if (!c) return;
            const t = c.currentTime + (o.at || 0);
            const osc = c.createOscillator();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(o.freq, t);
            if (o.bendTo) osc.frequency.exponentialRampToValueAtTime(o.bendTo, t + o.dur);
            if (o.detune) osc.detune.value = o.detune;
            const g = c.createGain();
            const attack = o.attack != null ? o.attack : 0.008;
            const peak = o.vol != null ? o.vol : 0.3;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(peak, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0005, t + o.dur);
            let node = osc;
            if (o.lp) {
                const f = c.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.value = o.lp;
                osc.connect(f);
                node = f;
            }
            node.connect(g);
            g.connect(o.bus || sfxBus);
            osc.start(t);
            osc.stop(t + o.dur + 0.05);
        }

        // Bell-ish partials: fundamental + octave + a slightly inharmonic 3rd.
        function bell(freq, dur, vol, at, bus) {
            tone({ freq: freq, type: 'sine', dur: dur, vol: vol, at: at, bus: bus });
            tone({ freq: freq * 2, type: 'sine', dur: dur * 0.6, vol: vol * 0.35, at: at, bus: bus });
            tone({ freq: freq * 3.01, type: 'sine', dur: dur * 0.35, vol: vol * 0.14, at: at, bus: bus });
        }

        // o: { dur, vol, at, type, from, to, q, attack, bus }
        function noise(o) {
            const c = ensureCtx();
            if (!c) return;
            const t = c.currentTime + (o.at || 0);
            const src = c.createBufferSource();
            src.buffer = noiseBuf();
            src.loop = true;
            const f = c.createBiquadFilter();
            f.type = o.type || 'bandpass';
            f.Q.value = o.q || 0.9;
            f.frequency.setValueAtTime(o.from || 1000, t);
            if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
            const g = c.createGain();
            const attack = o.attack != null ? o.attack : 0.01;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(o.vol || 0.2, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0005, t + o.dur);
            src.connect(f);
            f.connect(g);
            g.connect(o.bus || sfxBus);
            src.start(t);
            src.stop(t + o.dur + 0.05);
        }

        // ---- Sound effects ----

        function tick() { tone({ freq: 1500, type: 'sine', dur: 0.045, vol: 0.07 }); }
        function open() { tone({ freq: 740, type: 'sine', dur: 0.09, vol: 0.12 }); tone({ freq: 988, type: 'sine', dur: 0.12, vol: 0.1, at: 0.06 }); }
        function close() { tone({ freq: 988, type: 'sine', dur: 0.09, vol: 0.1 }); tone({ freq: 740, type: 'sine', dur: 0.12, vol: 0.1, at: 0.06 }); }

        function start() {
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, 0.55, 0.26, i * 0.09));
            noise({ dur: 0.7, vol: 0.12, from: 300, to: 5000, type: 'bandpass', attack: 0.25 });
        }

        function correct() {
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, 0.5, 0.3, i * 0.07));
            tone({ freq: 2093, type: 'sine', dur: 0.6, vol: 0.07, at: 0.3 });
            noise({ dur: 0.35, vol: 0.06, from: 2000, to: 6000, type: 'bandpass', attack: 0.02, at: 0.2 });
        }

        function wrong() {
            tone({ freq: 220, type: 'sawtooth', dur: 0.3, vol: 0.16, bendTo: 110, lp: 1400 });
            tone({ freq: 110, type: 'square', dur: 0.3, vol: 0.08, bendTo: 55, lp: 700 });
        }

        function skip() {
            tone({ freq: 440, type: 'triangle', dur: 0.14, vol: 0.22 });
            tone({ freq: 330, type: 'triangle', dur: 0.22, vol: 0.2, at: 0.12 });
        }

        function next() {
            tone({ freq: 660, type: 'sine', dur: 0.09, vol: 0.2 });
            tone({ freq: 990, type: 'sine', dur: 0.14, vol: 0.12, at: 0.07 });
        }

        // Air rushing past as the globe flies to a country.
        function whoosh(dur) {
            const d = dur || 1.3;
            noise({ dur: d, vol: 0.24, from: 220, to: 2800, type: 'bandpass', q: 0.7, attack: d * 0.45 });
            noise({ dur: d * 0.8, vol: 0.06, from: 80, to: 400, type: 'lowpass', attack: d * 0.3, at: d * 0.1 });
        }

        // Soft thump + ping when the camera settles on the country.
        function land() {
            tone({ freq: 170, type: 'sine', dur: 0.24, vol: 0.4, bendTo: 55 });
            bell(1318.5, 0.5, 0.14, 0.03);
        }

        function fanfare() {
            duck(2.2);
            const chords = [
                [523.25, 659.25, 783.99],
                [698.46, 880.0, 1046.5],
                [783.99, 987.77, 1174.66],
                [1046.5, 1318.51, 1567.98]
            ];
            chords.forEach((ch, i) => ch.forEach(f => bell(f, i === 3 ? 0.9 : 0.35, 0.2, i * 0.2)));
            [1567.98, 1760, 2093, 2349.3, 2637, 3135.96].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.25, vol: 0.08, at: 0.85 + i * 0.06 }));
            // crowd-ish cheer
            noise({ dur: 1.8, vol: 0.14, from: 500, to: 1400, type: 'bandpass', q: 0.5, attack: 0.35, at: 0.1 });
        }

        function capitalIntro() {
            [220, 261.63, 329.63, 440].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.32, vol: 0.2, at: i * 0.1, lp: 3000 }));
            noise({ dur: 0.55, vol: 0.07, from: 700, to: 3500, attack: 0.25 });
        }

        function capitalWin() {
            duck(1.4);
            [523.25, 659.25, 783.99].forEach(f => bell(f, 0.75, 0.22));
            [1046.5, 1318.51, 1567.98, 2093].forEach((f, i) => bell(f, 0.55, 0.18, 0.14 + i * 0.08));
            noise({ dur: 0.6, vol: 0.08, from: 1500, to: 6000, type: 'bandpass', attack: 0.1, at: 0.2 });
        }

        // ---- Music: an upbeat 8-bar loop (I–V–vi–IV, then I–V–IV–V) ----

        const TEMPO = 112;
        const STEP = 60 / TEMPO / 2;           // eighth note
        const STEPS_PER_BAR = 8;
        const BARS = 8;
        const TOTAL_STEPS = STEPS_PER_BAR * BARS;
        const midi = n => 440 * Math.pow(2, (n - 69) / 12);
        const chords = [
            { root: 36, tri: [60, 64, 67] }, // C
            { root: 31, tri: [59, 62, 67] }, // G
            { root: 33, tri: [60, 64, 69] }, // Am
            { root: 29, tri: [60, 65, 69] }, // F
            { root: 36, tri: [60, 64, 67] }, // C
            { root: 31, tri: [59, 62, 67] }, // G
            { root: 29, tri: [60, 65, 69] }, // F
            { root: 31, tri: [59, 62, 67] }  // G
        ];
        // Melody per eighth-note step (MIDI numbers, 0 = rest).
        const melody = [
            76, 0, 79, 0, 81, 79, 76, 0,
            74, 0, 71, 74, 0, 0, 76, 0,
            72, 0, 76, 0, 81, 0, 79, 76,
            77, 0, 76, 74, 0, 0, 72, 0,
            76, 0, 79, 0, 84, 0, 81, 79,
            74, 0, 79, 0, 71, 0, 74, 0,
            77, 0, 81, 0, 84, 81, 79, 77,
            79, 0, 0, 0, 74, 0, 0, 0
        ];
        const arpPattern = [0, 1, 2, 1, 0, 1, 2, 1];
        let step = 0;
        let loopCount = 0;
        let nextNoteTime = 0;

        function voice(freq, when, dur, type, vol, lp) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, when);
            g.gain.linearRampToValueAtTime(vol, when + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
            let node = osc;
            if (lp) {
                const f = ctx.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.value = lp;
                osc.connect(f);
                node = f;
            }
            node.connect(g);
            g.connect(musicBus);
            osc.start(when);
            osc.stop(when + dur + 0.03);
        }

        function drum(kind, when) {
            if (kind === 'kick') {
                const osc = ctx.createOscillator();
                const g = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(150, when);
                osc.frequency.exponentialRampToValueAtTime(42, when + 0.12);
                g.gain.setValueAtTime(0.55, when);
                g.gain.exponentialRampToValueAtTime(0.001, when + 0.16);
                osc.connect(g);
                g.connect(musicBus);
                osc.start(when);
                osc.stop(when + 0.2);
                return;
            }
            const src = ctx.createBufferSource();
            src.buffer = noiseBuf();
            src.loop = true;
            const f = ctx.createBiquadFilter();
            const g = ctx.createGain();
            let dur;
            if (kind === 'snare') {
                f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
                dur = 0.13; g.gain.setValueAtTime(0.16, when);
            } else { // hat
                f.type = 'highpass'; f.frequency.value = 8000;
                dur = kind === 'hat-accent' ? 0.05 : 0.03;
                g.gain.setValueAtTime(kind === 'hat-accent' ? 0.085 : 0.05, when);
            }
            g.gain.exponentialRampToValueAtTime(0.001, when + dur);
            src.connect(f); f.connect(g); g.connect(musicBus);
            src.start(when);
            src.stop(when + dur + 0.02);
        }

        function scheduleStep(stepIndex, when) {
            const bar = Math.floor(stepIndex / STEPS_PER_BAR) % BARS;
            const beat = stepIndex % STEPS_PER_BAR;
            const chord = chords[bar];

            // drums
            if (beat === 0 || beat === 4) drum('kick', when);
            if (beat === 2 || beat === 6) drum('snare', when);
            drum(beat % 2 === 1 ? 'hat-accent' : 'hat', when);

            // bass
            if (beat === 0 || beat === 3) voice(midi(chord.root), when, 0.34, 'triangle', 0.32);
            if (beat === 4) voice(midi(chord.root + 7), when, 0.3, 'triangle', 0.28);
            if (beat === 6) voice(midi(chord.root + 12), when, 0.2, 'triangle', 0.22);

            // pad
            if (beat === 0) {
                chord.tri.forEach(n => voice(midi(n), when, STEP * STEPS_PER_BAR * 0.96, 'triangle', 0.045, 1800));
            }

            // arpeggio
            voice(midi(chord.tri[arpPattern[beat]] + 12), when, STEP * 0.9, 'sine', 0.06);

            // melody (rests for one loop in three so it never gets tiring)
            const note = melody[stepIndex % TOTAL_STEPS];
            if (note && loopCount % 3 !== 2) {
                voice(midi(note), when, STEP * 1.7, 'triangle', 0.1, 2600);
                voice(midi(note), when, STEP * 1.7, 'square', 0.018, 1500);
            }
        }

        function musicScheduler() {
            if (!musicTimer) return;
            while (nextNoteTime < ctx.currentTime + 0.16) {
                scheduleStep(step, nextNoteTime);
                nextNoteTime += STEP;
                step += 1;
                if (step >= TOTAL_STEPS) { step = 0; loopCount += 1; }
            }
            musicTimer = setTimeout(musicScheduler, 30);
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

        function isPlaying() { return !!musicTimer; }

        return {
            ensureCtx, unlock, setMusicEnabled, setSfxEnabled, duck,
            tick, open, close, start, correct, wrong, skip, next, whoosh, land,
            fanfare, capitalIntro, capitalWin, startMusic, stopMusic, isPlaying
        };
    })();

    // ---- Starfield backdrop ----------------------------------------------

    const stars = (function () {
        const canvas = $("stars");
        if (!canvas) return { draw: function () {} };
        const c = canvas.getContext('2d');
        function draw() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = window.innerWidth, h = window.innerHeight;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            c.setTransform(dpr, 0, 0, dpr, 0, 0);
            c.clearRect(0, 0, w, h);
            const count = Math.round((w * h) / 6500);
            for (let i = 0; i < count; i++) {
                const x = Math.random() * w;
                const y = Math.random() * h;
                const r = Math.random() < 0.85 ? Math.random() * 1.1 + 0.3 : Math.random() * 1.8 + 1;
                const a = 0.25 + Math.random() * 0.6;
                c.beginPath();
                c.arc(x, y, r, 0, Math.PI * 2);
                c.fillStyle = 'rgba(' + (Math.random() < 0.2 ? '255,214,170' : '220,232,255') + ',' + a.toFixed(2) + ')';
                c.fill();
            }
        }
        return { draw };
    })();

    // ---- Globe (orthographic canvas, d3-geo) -----------------------------

    const globe = (function () {
        const canvas = $("globe");
        const panel = $("globe-panel");
        const c = canvas.getContext('2d');
        const hasD3 = !!(window.d3 && window.d3.geoOrthographic);

        const IDLE_TILT = -22;          // centre latitude while idling (22°N)
        const SPIN_SPEED = reducedMotion ? 0 : 5.5;  // degrees per second
        const LAND_COLORS = ['#f2d78d', '#e8c776', '#f7e3a4', '#dfc16c', '#efd28a', '#e5cd8c', '#f9e7ae'];
        const HILITE = '#ff3d6f';
        const MAX_ZOOM = 12;

        let width = 0, height = 0, dpr = 1, fitR = 100;
        let rotation = [-20, IDLE_TILT, 0];
        let zoom = 1;
        let mode = 'spin';           // 'spin' | 'fly' | 'hold'
        let fly = null;
        let groups = [];
        let allLand = null;
        let byKey = new Map();
        let highlight = null;
        let ready = false;
        let running = false;
        let rafId = 0;
        let lastT = 0;
        let holdT = 0;
        let loadingT = 0;

        let projection = null, path = null, graticule = null;
        if (hasD3) {
            projection = d3.geoOrthographic().clipAngle(90).precision(0.35);
            path = d3.geoPath(projection, c);
            graticule = d3.geoGraticule10();
        }

        // -- data --

        function polygonsOf(geom) {
            if (!geom) return [];
            if (geom.type === 'Polygon') return [geom.coordinates];
            if (geom.type === 'MultiPolygon') return geom.coordinates;
            return [];
        }

        // d3 wants clockwise exterior rings; a polygon that "covers" more than a
        // hemisphere is inverted, so flip it.
        function fixWinding(feature) {
            polygonsOf(feature.geometry).forEach(coords => {
                if (d3.geoArea({ type: 'Polygon', coordinates: coords }) > 2 * Math.PI) {
                    coords.forEach(ring => ring.reverse());
                }
            });
        }

        function setData(features) {
            const feats = features.filter(f => f && f.geometry && f.properties && !skipContinents.has(f.properties.continent));
            if (hasD3) feats.forEach(fixWinding);
            const buckets = new Map();
            byKey = new Map();
            feats.forEach(f => {
                const p = f.properties;
                const idx = (((parseInt(p.mapcolor7, 10) || 1) - 1) % LAND_COLORS.length + LAND_COLORS.length) % LAND_COLORS.length;
                if (!buckets.has(idx)) buckets.set(idx, []);
                buckets.get(idx).push(f);
                const code = (p.iso_a3 && p.iso_a3 !== '-99') ? String(p.iso_a3).toUpperCase() : null;
                if (code) byKey.set('code:' + code, f);
                if (p.name) byKey.set('name:' + String(p.name).toLowerCase(), f);
            });
            groups = [];
            buckets.forEach((fs, idx) => {
                groups.push({ color: LAND_COLORS[idx], fc: { type: 'FeatureCollection', features: fs } });
            });
            allLand = { type: 'FeatureCollection', features: feats };
            ready = true;
            requestRender();
        }

        function findFeature(country) {
            if (!country) return null;
            const byCode = country.code ? byKey.get('code:' + String(country.code).toUpperCase()) : null;
            if (byCode) return byCode;
            return byKey.get('name:' + String(country.country || '').toLowerCase()) || null;
        }

        // -- geometry helpers (spherical with d3, planar fallback) --

        function polyCentroid(coords) {
            if (hasD3) return d3.geoCentroid({ type: 'Polygon', coordinates: coords });
            const ring = coords[0];
            let x = 0, y = 0;
            ring.forEach(pt => { x += pt[0]; y += pt[1]; });
            return [x / ring.length, y / ring.length];
        }

        function polyArea(coords) {
            if (hasD3) return d3.geoArea({ type: 'Polygon', coordinates: coords });
            const ring = coords[0];
            let a = 0;
            for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length];
                a += p[0] * q[1] - q[0] * p[1];
            }
            return Math.abs(a / 2);
        }

        function angularDistanceDeg(a, b) {
            if (hasD3) return d3.geoDistance(a, b) * 180 / Math.PI;
            let dlon = Math.abs(a[0] - b[0]);
            if (dlon > 180) dlon = 360 - dlon;
            return Math.sqrt(dlon * dlon + (a[1] - b[1]) * (a[1] - b[1]));
        }

        // The part of a country we should frame: its biggest landmass plus any
        // other polygons chained within 30° of it. This keeps French Guiana
        // from dragging France into the Atlantic, and Alaska/Hawaii from
        // shrinking the continental US, while still framing all of Indonesia.
        function mainCluster(geom) {
            const polys = polygonsOf(geom);
            if (polys.length <= 1) return geom;
            const info = polys.map(coords => ({ coords, area: polyArea(coords), centroid: polyCentroid(coords) }));
            let big = 0;
            info.forEach((p, i) => { if (p.area > info[big].area) big = i; });
            const keep = new Set([big]);
            let grew = true;
            while (grew) {
                grew = false;
                info.forEach((p, i) => {
                    if (keep.has(i)) return;
                    for (const k of keep) {
                        if (angularDistanceDeg(p.centroid, info[k].centroid) < 30) { keep.add(i); grew = true; break; }
                    }
                });
            }
            return { type: 'MultiPolygon', coordinates: info.filter((p, i) => keep.has(i)).map(p => p.coords) };
        }

        function focusTarget(feature) {
            const geom = mainCluster(feature.geometry);
            let rot, z = 1;
            if (hasD3) {
                const centroid = d3.geoCentroid(geom);
                rot = [-centroid[0], -centroid[1], 0];
                projection.rotate(rot).scale(fitR);
                const b = path.bounds(geom);
                const bw = Math.max(2, b[1][0] - b[0][0]);
                const bh = Math.max(2, b[1][1] - b[0][1]);
                const disc = fitR * 2;
                z = Math.min(disc * 0.6 / bw, disc * 0.6 / bh);
            } else {
                const polys = polygonsOf(geom);
                let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
                polys.forEach(coords => coords[0].forEach(pt => {
                    minLon = Math.min(minLon, pt[0]); maxLon = Math.max(maxLon, pt[0]);
                    minLat = Math.min(minLat, pt[1]); maxLat = Math.max(maxLat, pt[1]);
                }));
                rot = [-(minLon + maxLon) / 2, -(minLat + maxLat) / 2, 0];
                const k0 = flatScale();
                const disc = fitR * 2;
                z = Math.min(disc * 0.6 / Math.max(2, (maxLon - minLon) * k0), disc * 0.6 / Math.max(2, (maxLat - minLat) * k0));
            }
            if (!isFinite(z)) z = 1;
            return { rot: rot, zoom: clamp(z, 1, MAX_ZOOM) };
        }

        // -- sizing --

        function resize() {
            const r = panel.getBoundingClientRect();
            const w = Math.max(10, Math.round(r.width));
            const h = Math.max(10, Math.round(r.height));
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
            if (canvas.width !== bw || canvas.height !== bh) {
                canvas.width = bw;
                canvas.height = bh;
            }
            width = w;
            height = h;
            fitR = Math.min(width, height) * 0.5 * 0.92;
            if (projection) projection.translate([width / 2, height / 2]);
            requestRender();
        }

        function flatScale() { return Math.min(width / 360, height / 180); }

        // -- drawing --

        function lerpAngle(a, b, t) {
            const d = ((b - a + 540) % 360) - 180;
            return a + d * t;
        }

        function drawLoading() {
            const cx = width / 2, cy = height / 2;
            const R = fitR;
            const g = c.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
            g.addColorStop(0, '#2d5cc0');
            g.addColorStop(1, '#0b2361');
            c.fillStyle = g;
            c.beginPath();
            c.arc(cx, cy, R, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = 'rgba(255,255,255,0.25)';
            c.lineWidth = 3;
            c.setLineDash([R * 0.25, R * 0.12]);
            c.lineDashOffset = -loadingT * 60;
            c.beginPath();
            c.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
            c.stroke();
            c.setLineDash([]);
            c.fillStyle = 'rgba(255,255,255,0.85)';
            c.font = '600 ' + Math.max(14, Math.round(R * 0.11)) + 'px Fredoka, sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText('Loading the world…', cx, cy);
        }

        function drawSphereShading(cx, cy, R) {
            const sg = c.createRadialGradient(cx - R * 0.38, cy - R * 0.38, R * 0.12, cx, cy, R);
            sg.addColorStop(0, 'rgba(255,255,255,0.17)');
            sg.addColorStop(0.42, 'rgba(255,255,255,0)');
            sg.addColorStop(0.82, 'rgba(0,0,0,0.12)');
            sg.addColorStop(1, 'rgba(0,0,0,0.5)');
            c.fillStyle = sg;
            c.beginPath();
            c.arc(cx, cy, R, 0, Math.PI * 2);
            c.fill();
            c.beginPath();
            c.arc(cx, cy, R, 0, Math.PI * 2);
            c.strokeStyle = 'rgba(190,220,255,0.55)';
            c.lineWidth = 1.5;
            c.stroke();
        }

        function renderGlobe() {
            const R = fitR * zoom;          // projection scale (the sphere's true radius)
            const D = fitR;                 // the disc we look through — the planet on screen
            const cx = width / 2, cy = height / 2;
            projection.rotate(rotation).scale(R);

            // atmosphere halo
            const ag = c.createRadialGradient(cx, cy, D * 0.9, cx, cy, D * 1.12);
            ag.addColorStop(0, 'rgba(96,165,250,0)');
            ag.addColorStop(0.5, 'rgba(96,165,250,0.38)');
            ag.addColorStop(1, 'rgba(96,165,250,0)');
            c.fillStyle = ag;
            c.beginPath();
            c.arc(cx, cy, D * 1.12, 0, Math.PI * 2);
            c.fill();

            c.save();
            c.beginPath();
            c.arc(cx, cy, D, 0, Math.PI * 2);
            c.clip();

            // ocean
            const og = c.createRadialGradient(cx - D * 0.3, cy - D * 0.3, D * 0.1, cx, cy, D);
            og.addColorStop(0, '#3f7fe0');
            og.addColorStop(0.6, '#1e4db3');
            og.addColorStop(1, '#0b2a70');
            c.fillStyle = og;
            c.fillRect(cx - D, cy - D, D * 2, D * 2);

            // graticule
            c.beginPath();
            path(graticule);
            c.strokeStyle = 'rgba(255,255,255,0.09)';
            c.lineWidth = 0.8;
            c.stroke();

            // land
            c.lineJoin = 'round';
            c.lineCap = 'round';
            const borderW = clamp(0.55 * Math.sqrt(zoom), 0.6, 2.2);
            groups.forEach(gp => {
                c.beginPath();
                path(gp.fc);
                c.fillStyle = gp.color;
                c.fill();
            });
            c.beginPath();
            path(allLand);
            c.strokeStyle = 'rgba(95,60,20,0.55)';
            c.lineWidth = borderW;
            c.stroke();

            // highlighted country
            if (highlight) {
                const pulse = 0.5 + 0.5 * Math.sin(holdT * 4);
                c.save();
                c.shadowColor = 'rgba(255,61,111,' + (0.55 + 0.4 * pulse).toFixed(3) + ')';
                c.shadowBlur = 18 + 16 * pulse;
                c.beginPath();
                path(highlight);
                c.fillStyle = HILITE;
                c.fill();
                c.restore();
                c.beginPath();
                path(highlight);
                c.strokeStyle = '#ffffff';
                c.lineWidth = Math.max(1.4, borderW * 1.6);
                c.stroke();

                // a pulsing ring so tiny countries are unmistakable
                if (mode !== 'fly') {
                    const b = path.bounds(highlight);
                    const bw = b[1][0] - b[0][0], bh = b[1][1] - b[0][1];
                    if (isFinite(bw) && isFinite(bh) && bw < D * 0.45 && bh < D * 0.45) {
                        const rr = Math.max(bw, bh) / 2 + D * (0.1 + 0.025 * pulse);
                        c.beginPath();
                        c.arc((b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, rr, 0, Math.PI * 2);
                        c.strokeStyle = 'rgba(255,255,255,' + (0.45 + 0.45 * pulse).toFixed(3) + ')';
                        c.lineWidth = 3;
                        c.setLineDash([12, 9]);
                        c.stroke();
                        c.setLineDash([]);
                    }
                }
            }

            c.restore();
            drawSphereShading(cx, cy, D);
        }

        // Flat equirectangular fallback used only if d3 failed to load.
        function flatPath(geom, k, cx, cy) {
            polygonsOf(geom).forEach(coords => coords.forEach(ring => {
                for (let i = 0; i < ring.length; i++) {
                    const x = cx + (ring[i][0] + rotation[0]) * k;
                    const y = cy - (ring[i][1] + rotation[1]) * k;
                    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
                }
                c.closePath();
            }));
        }

        function renderFlat() {
            const k = flatScale() * zoom;
            const cx = width / 2, cy = height / 2;
            const D = fitR;
            c.save();
            c.beginPath();
            c.arc(cx, cy, D, 0, Math.PI * 2);
            c.clip();
            const g = c.createRadialGradient(cx - D * 0.3, cy - D * 0.3, D * 0.1, cx, cy, D);
            g.addColorStop(0, '#3f7fe0');
            g.addColorStop(0.6, '#1e4db3');
            g.addColorStop(1, '#0b2a70');
            c.fillStyle = g;
            c.fillRect(0, 0, width, height);
            c.lineJoin = 'round';
            groups.forEach(gp => {
                c.beginPath();
                gp.fc.features.forEach(f => flatPath(f.geometry, k, cx, cy));
                c.fillStyle = gp.color;
                c.fill();
                c.strokeStyle = 'rgba(95,60,20,0.55)';
                c.lineWidth = clamp(0.5 * Math.sqrt(zoom), 0.5, 2);
                c.stroke();
            });
            if (highlight) {
                c.beginPath();
                flatPath(highlight.geometry, k, cx, cy);
                c.fillStyle = HILITE;
                c.fill();
                c.strokeStyle = '#fff';
                c.lineWidth = 2;
                c.stroke();
            }
            c.restore();
            drawSphereShading(cx, cy, D);
        }

        function render() {
            if (!width || !height) return;
            c.setTransform(dpr, 0, 0, dpr, 0, 0);
            c.clearRect(0, 0, width, height);
            if (!ready) { drawLoading(); return; }
            if (hasD3) renderGlobe(); else renderFlat();
        }

        // -- animation loop --

        function tick(now) {
            rafId = 0;
            const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
            lastT = now;
            let animating = false;

            if (!ready) {
                loadingT += dt;
                animating = true;
            } else if (mode === 'spin') {
                if (hasD3) {
                    rotation[0] += SPIN_SPEED * dt;
                    if (rotation[0] > 360) rotation[0] -= 360;
                    animating = SPIN_SPEED > 0;
                }
            } else if (mode === 'fly' && fly) {
                const t = clamp((now - fly.t0) / fly.dur, 0, 1);
                const er = easeInOutCubic(t);
                rotation = [
                    lerpAngle(fly.r0[0], fly.r1[0], er),
                    fly.r0[1] + (fly.r1[1] - fly.r0[1]) * er,
                    0
                ];
                const zt = fly.zoomDelay < 1 ? clamp((t - fly.zoomDelay) / (1 - fly.zoomDelay), 0, 1) : t;
                const ez = fly.z1 < fly.z0 ? easeOutCubic(zt) : easeInOutCubic(zt);
                zoom = (fly.z0 + (fly.z1 - fly.z0) * ez) * (1 - fly.dip * Math.sin(Math.PI * t));
                animating = true;
                if (t >= 1) {
                    zoom = fly.z1;
                    rotation = fly.r1.slice();
                    const done = fly;
                    fly = null;
                    mode = done.next;
                    holdT = 0;
                    if (done.onDone) done.onDone();
                }
            } else if (mode === 'hold') {
                holdT += dt;
                animating = !!highlight && !reducedMotion;
            }

            render();
            if (running && animating) rafId = requestAnimationFrame(tick);
            else lastT = 0;
        }

        function kick() {
            if (!running) return;
            if (!rafId) { lastT = 0; rafId = requestAnimationFrame(tick); }
        }

        function requestRender() { kick(); }

        function start() {
            running = true;
            resize();
            kick();
        }

        function flyTo(r1, z1, o) {
            fly = {
                t0: performance.now(),
                dur: reducedMotion ? 1 : (o.dur || 1500),
                r0: rotation.slice(),
                r1: [r1[0], r1[1], 0],
                z0: zoom,
                z1: z1,
                zoomDelay: o.zoomDelay || 0,
                dip: o.dip || 0,
                next: o.next || 'hold',
                onDone: o.onDone || null
            };
            mode = 'fly';
            kick();
        }

        // Fly to a country, zoom in and hold with it highlighted.
        function focusCountry(country, onDone) {
            const feature = findFeature(country);
            highlight = feature;
            holdT = 0;
            if (!feature || !ready) {
                if (onDone) onDone(false);
                requestRender();
                return 0;
            }
            const target = focusTarget(feature);
            const dur = 1700;
            flyTo(target.rot, target.zoom, {
                dur: dur, zoomDelay: 0.25, dip: 0, next: 'hold',
                onDone: function () { if (onDone) onDone(true); }
            });
            return dur;
        }

        // Drop the highlight and glide back out to the spinning overview.
        function release() {
            highlight = null;
            if (!ready) return;
            if (!hasD3) {
                flyTo([0, -10, 0], 1, { dur: 900, next: 'hold' });
                return;
            }
            flyTo([rotation[0], IDLE_TILT, 0], 1, { dur: 1000, next: 'spin' });
        }

        function init() {
            if (typeof ResizeObserver === 'function') {
                new ResizeObserver(() => resize()).observe(panel);
            }
            window.addEventListener('resize', resize);
            if (!hasD3) rotation = [0, -10, 0];
        }

        return { init, start, setData, focusCountry, release, resize, requestRender, hasD3: hasD3 };
    })();

    // ---- Country data -----------------------------------------------------

    function loadGeojson() {
        if (!geojsonPromise) {
            geojsonPromise = fetch('custom.geo.json').then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
        }
        return geojsonPromise;
    }

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
                globe.setData(features);
                if (countryData.length === 0) {
                    countryDisplay.textContent = "No country data available.";
                    return;
                }
                startGame();
            })
            .catch(err => {
                console.error('Error loading country data:', err);
                countryDisplay.textContent = "Failed to load country data.";
            });
    }

    function capitalFor(country) {
        return (country && country.code && CAPITALS[country.code]) || null;
    }

    // ---- HUD rollers ------------------------------------------------------

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

    let lastShown = { streak: null, best: null, total: null };

    function bumpStat(rollerEl) {
        const stat = rollerEl.parentElement;
        if (!stat) return;
        stat.classList.remove('bump');
        void stat.offsetWidth;
        stat.classList.add('bump');
    }

    function updateCounters() {
        setRoller(streakRollerEl, streak);
        setRoller(bestRollerEl, best);
        setRoller(totalRollerEl, total);
        streakRollerEl.classList.remove('streak-on-fire', 'streak-blazing', 'streak-legendary');
        const cls = streakClass(streak);
        if (cls) streakRollerEl.classList.add(cls);
        if (lastShown.streak !== null && streak > lastShown.streak) bumpStat(streakRollerEl);
        if (lastShown.best !== null && best > lastShown.best) bumpStat(bestRollerEl);
        if (lastShown.total !== null && total > lastShown.total) bumpStat(totalRollerEl);
        lastShown = { streak, best, total };
    }

    // ---- Settings ---------------------------------------------------------

    function syncSettingsUI() {
        toggleMusicEl.setAttribute('aria-pressed', musicEnabled ? 'true' : 'false');
        toggleSfxEl.setAttribute('aria-pressed', sfxEnabled ? 'true' : 'false');
    }

    function openSettings() {
        showEl(settingsPanel);
        settingsButton.setAttribute('aria-expanded', 'true');
        audio.open();
        toggleMusicEl.focus({ preventScroll: true });
    }
    // After closing, focus goes back to the game's primary control so a TV
    // remote's OK button carries on with the round instead of reopening the panel.
    function focusPrimaryControl() {
        const target = !isHidden(nextButton) ? nextButton
            : (phase === 'capital' ? capitalContainer : continentContainer).querySelector('.choice-button:not(:disabled)');
        if (target) target.focus({ preventScroll: true });
        else settingsButton.focus({ preventScroll: true });
    }

    function closeSettings(silent) {
        if (isHidden(settingsPanel)) return;
        hideEl(settingsPanel);
        settingsButton.setAttribute('aria-expanded', 'false');
        cancelResetConfirm();
        if (!silent) audio.close();
        focusPrimaryControl();
    }
    function toggleSettings() {
        if (isHidden(settingsPanel)) openSettings(); else closeSettings();
    }

    function setMusic(on) {
        musicEnabled = on;
        saveStore({ musicEnabled: on });
        audio.setMusicEnabled(on);
        if (gameStarted) {
            if (on) audio.startMusic(); else audio.stopMusic();
        }
        syncSettingsUI();
    }

    function setSfx(on) {
        sfxEnabled = on;
        saveStore({ sfxEnabled: on });
        audio.setSfxEnabled(on);
        syncSettingsUI();
        if (on) audio.tick();
    }

    let resetConfirmTimer = null;
    function cancelResetConfirm() {
        if (resetConfirmTimer) { clearTimeout(resetConfirmTimer); resetConfirmTimer = null; }
        resetButton.classList.remove('confirming');
        resetButton.textContent = 'Reset progress';
    }

    // Two presses to reset: no window.confirm() dialogs on a TV.
    function resetProgress() {
        if (!resetButton.classList.contains('confirming')) {
            resetButton.classList.add('confirming');
            resetButton.textContent = 'Press again to confirm';
            audio.tick();
            resetConfirmTimer = setTimeout(cancelResetConfirm, 4000);
            return;
        }
        cancelResetConfirm();
        streak = 0;
        total = 0;
        best = 0;
        saveStore({ total: 0, best: 0 });
        updateCounters();
        audio.skip();
        closeSettings();
    }

    function toggleFullscreen() {
        const d = document;
        const el = d.documentElement;
        try {
            const active = d.fullscreenElement || d.webkitFullscreenElement;
            if (!active) {
                const req = el.requestFullscreen || el.webkitRequestFullscreen;
                if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
            } else {
                const exit = d.exitFullscreen || d.webkitExitFullscreen;
                if (exit) { const p = exit.call(d); if (p && p.catch) p.catch(() => {}); }
            }
        } catch (e) { /* ignore */ }
    }

    // ---- Banner + confetti -----------------------------------------------

    let bannerTimer = null;
    function showBanner(text, kind) {
        bannerText.textContent = text;
        bannerEl.className = '';
        void bannerEl.offsetWidth;
        bannerEl.classList.add('show', kind || 'good');
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => { bannerEl.className = ''; }, 1100);
    }

    function playConfetti(opts) {
        if (typeof confetti !== 'function' || reducedMotion) return;
        confetti(Object.assign({ particleCount: 140, spread: 80, startVelocity: 55, scalar: 1.35, origin: { x: 0.5, y: 0.55 }, zIndex: 35 }, opts || {}));
    }

    function bigConfetti() {
        playConfetti({ particleCount: 120, spread: 70, angle: 60, origin: { x: 0.05, y: 0.7 } });
        playConfetti({ particleCount: 120, spread: 70, angle: 120, origin: { x: 0.95, y: 0.7 } });
        setTimeout(() => playConfetti({ particleCount: 200, spread: 120, origin: { x: 0.5, y: 0.4 } }), 250);
    }

    // ---- Globe caption ----------------------------------------------------

    function showCaption(country, detailHtml) {
        captionFlag.src = country.flagUrl;
        captionFlag.alt = '';
        captionFlag.hidden = false;
        captionName.textContent = country.country;
        captionDetail.innerHTML = detailHtml;
        showEl(captionEl);
        captionEl.style.animation = 'none';
        void captionEl.offsetWidth;
        captionEl.style.animation = '';
    }

    function hideCaption() {
        hideEl(captionEl);
    }

    // ---- Round flow -------------------------------------------------------

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

    function setResult(text, kind) {
        resultDisplay.textContent = text;
        resultDisplay.className = kind || '';
        if (text) animateOnce(resultDisplay, 'entering');
    }

    function setQuestion(html) {
        countryDisplay.innerHTML = html;
        animateOnce(countryDisplay, 'entering');
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

    function focusFirstChoice() {
        const first = continentContainer.querySelector('.choice-button:not(:disabled)');
        if (first) first.focus({ preventScroll: true });
    }

    function startGame() {
        if (countryData.length === 0) {
            countryDisplay.textContent = "No country data available.";
            return;
        }
        phase = 'continent';
        firstTryWrong = false;

        setResult('', '');
        hideCaption();

        hideEl(capitalContainer);
        capitalContainer.innerHTML = '';
        showEl(continentContainer);
        resetChoiceButtons(continentContainer);

        showEl(skipButton);
        skipButton.disabled = false;
        hideEl(capitalButton);
        hideEl(nextButton);

        currentCountry = nextCountry();
        setQuestion('Which continent is <span class="q-country">' + escapeHtml(currentCountry.country) + '</span> in?');
        countryFlag.src = currentCountry.flagUrl;
        countryFlag.alt = currentCountry.country + " flag";
        countryFlag.hidden = false;
        animateOnce(countryFlag, 'entering');
        updateCounters();
        focusFirstChoice();
    }

    function revealOnGlobe() {
        const country = currentCountry;
        const dur = globe.focusCountry(country, function (found) {
            if (currentCountry !== country) return;
            if (found) audio.land();
            showCaption(country, 'in <strong>' + escapeHtml(country.continent) + '</strong>');
        });
        if (dur > 0) audio.whoosh(dur / 1000 * 0.85);
    }

    function finishContinent() {
        phase = 'done';
        disableChoiceButtons(continentContainer);
        hideEl(skipButton);
        revealOnGlobe();
        if (capitalFor(currentCountry)) showEl(capitalButton); else hideEl(capitalButton);
        showEl(nextButton);
        updateCounters();
        nextButton.focus({ preventScroll: true });
    }

    function checkContinent(selected, button) {
        if (phase !== 'continent' || !currentCountry) return;

        if (selected === currentCountry.continent) {
            const firstTry = !firstTryWrong;
            total += 1;
            if (firstTry) streak += 1; else streak = 0;
            if (streak > best) best = streak;
            saveStore({ total: total, best: best });

            button.classList.add('correct');
            animateOnce(countryFlag, 'pulse');
            const milestone = firstTry && (streak === 5 || (streak >= 10 && streak % 5 === 0));
            if (milestone) {
                setResult('Correct! ' + streak + ' in a row!', 'good');
                showBanner(streak + ' STREAK!', 'epic');
                audio.fanfare();
                bigConfetti();
            } else {
                setResult(firstTry ? 'Correct!' : 'Correct — but the streak resets.', 'good');
                showBanner('CORRECT!', 'good');
                audio.correct();
                playConfetti();
            }
            finishContinent();
        } else {
            if (!firstTryWrong) {
                firstTryWrong = true;
                streak = 0;
                updateCounters();
            }
            setResult('Not ' + selected + '. Try again!', 'bad');
            showBanner('TRY AGAIN', 'bad');
            button.classList.add('incorrect');
            button.disabled = true;
            animateOnce(button, 'shake');
            audio.wrong();
            focusFirstChoice();
        }
    }

    function skipCurrent() {
        if (phase !== 'continent' || !currentCountry || isHidden(skipButton)) return;
        streak = 0;
        firstTryWrong = true;
        setResult("It's in " + currentCountry.continent + ".", 'neutral');
        showBanner('SKIPPED', 'neutral');
        continentContainer.querySelectorAll('.choice-button').forEach(b => {
            if (b.dataset.value === currentCountry.continent) b.classList.add('correct');
        });
        audio.skip();
        finishContinent();
    }

    function startCapitalRound() {
        const correct = capitalFor(currentCountry);
        if (!correct || isHidden(capitalButton)) return;
        phase = 'capital';

        setQuestion('What is the capital of <span class="q-country">' + escapeHtml(currentCountry.country) + '</span>?');
        hideEl(capitalButton);
        hideEl(nextButton);
        hideEl(skipButton);
        hideEl(continentContainer);

        const pool = allCapitals.filter(c => c !== correct);
        shuffle(pool);
        const options = shuffle(pool.slice(0, 3).concat([correct]));

        capitalContainer.innerHTML = '';
        options.forEach((cap, idx) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'choice-button capital-choice';
            b.dataset.value = cap;
            b.innerHTML = '<span class="num">' + (idx + 1) + '</span>' + escapeHtml(cap);
            b.title = cap + ' (' + (idx + 1) + ')';
            b.addEventListener('click', () => checkCapital(cap, b, correct));
            capitalContainer.appendChild(b);
        });
        showEl(capitalContainer);
        setResult('Worth 2 points!', 'neutral');
        audio.capitalIntro();
        const first = capitalContainer.querySelector('.choice-button');
        if (first) first.focus({ preventScroll: true });
    }

    function checkCapital(selected, button, correct) {
        if (phase !== 'capital') return;
        disableChoiceButtons(capitalContainer);

        if (selected === correct) {
            total += 2; // capitals are worth two points
            saveStore({ total: total });
            setResult('Correct! +2 points', 'good');
            showBanner('+2 CAPITAL!', 'epic');
            button.classList.add('correct');
            playConfetti({ particleCount: 180, spread: 100 });
            audio.capitalWin();
        } else {
            setResult('The capital is ' + correct + '.', 'bad');
            showBanner('NOT QUITE', 'bad');
            button.classList.add('incorrect');
            animateOnce(button, 'shake');
            capitalContainer.querySelectorAll('.choice-button').forEach(b => {
                if (b.dataset.value === correct) b.classList.add('correct');
            });
            audio.wrong();
        }
        showCaption(currentCountry, 'in <strong>' + escapeHtml(currentCountry.continent) + '</strong> &middot; Capital: <strong>' + escapeHtml(correct) + '</strong>');
        phase = 'done';
        showEl(nextButton);
        updateCounters();
        nextButton.focus({ preventScroll: true });
    }

    function advance() {
        if (isHidden(nextButton)) return;
        audio.next();
        globe.release();
        startGame();
    }

    function createContinentButtons() {
        continentContainer.innerHTML = '';
        continents.forEach((continent, idx) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "choice-button c" + idx;
            button.dataset.value = continent;
            button.innerHTML = '<span class="num">' + (idx + 1) + '</span>' + escapeHtml(continent);
            button.title = continent + ' (' + (idx + 1) + ')';
            button.addEventListener('click', () => checkContinent(continent, button));
            continentContainer.appendChild(button);
        });
    }

    function initializeGame() {
        if (gameInitialized) return;
        gameInitialized = true;
        createContinentButtons();
        updateCounters();
        globe.start();
        loadCountryData();
    }

    // ---- Keyboard + remote-control navigation ----------------------------

    function isTypingTarget(t) {
        if (!t) return false;
        return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    }

    function isVisible(el) {
        if (!el || el.disabled) return false;
        const rects = el.getClientRects();
        return rects.length > 0 && rects[0].width > 0;
    }

    function focusableButtons() {
        const scope = !isHidden(settingsPanel) ? settingsPanel : gameContainer;
        return Array.from(scope.querySelectorAll('button')).filter(isVisible);
    }

    // Spatial navigation for arrow keys / D-pads: move to the nearest button
    // in the pressed direction.
    function moveFocus(dir) {
        const items = focusableButtons();
        if (!items.length) return;
        const cur = document.activeElement;
        if (items.indexOf(cur) === -1) { items[0].focus({ preventScroll: true }); audio.tick(); return; }
        const cr = cur.getBoundingClientRect();
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        let bestEl = null, bestScore = Infinity;
        items.forEach(b => {
            if (b === cur) return;
            const r = b.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const dx = x - cx, dy = y - cy;
            let primary, secondary;
            if (dir === 'left')       { primary = -dx; secondary = Math.abs(dy); }
            else if (dir === 'right') { primary = dx;  secondary = Math.abs(dy); }
            else if (dir === 'up')    { primary = -dy; secondary = Math.abs(dx); }
            else                      { primary = dy;  secondary = Math.abs(dx); }
            if (primary <= 2) return;
            const score = primary + secondary * 2.5;
            if (score < bestScore) { bestScore = score; bestEl = b; }
        });
        if (bestEl) { bestEl.focus({ preventScroll: true }); audio.tick(); }
    }

    const arrowDirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;
        const key = e.key;
        const active = document.activeElement;
        const activeIsButton = !!(active && active.tagName === 'BUTTON' && !active.disabled && isVisible(active));

        if (key === 'Escape') {
            if (!isHidden(settingsPanel)) { closeSettings(); e.preventDefault(); }
            return;
        }
        if (key === 'f' || key === 'F') { toggleFullscreen(); e.preventDefault(); return; }
        if (key === 'm' || key === 'M') { setMusic(!musicEnabled); e.preventDefault(); return; }

        if (!gameStarted) {
            if ((key === 'Enter' || key === ' ') && !activeIsButton) { startButton.click(); e.preventDefault(); }
            return;
        }

        if (arrowDirs[key]) { moveFocus(arrowDirs[key]); e.preventDefault(); return; }

        if (key === 'Enter' || key === ' ') {
            if (activeIsButton) return;             // the browser will click it
            if (!isHidden(nextButton)) { advance(); e.preventDefault(); }
            return;
        }
        if (!isHidden(settingsPanel)) return;

        if (key === 's' || key === 'S') {
            if (!isHidden(skipButton) && !skipButton.disabled) { skipCurrent(); e.preventDefault(); }
            return;
        }
        if (key === 'c' || key === 'C') {
            if (!isHidden(capitalButton)) { startCapitalRound(); e.preventDefault(); }
            return;
        }
        if (key === 'n' || key === 'N') {
            if (!isHidden(nextButton)) { advance(); e.preventDefault(); }
            return;
        }
        if (/^[1-9]$/.test(key)) {
            const idx = parseInt(key, 10) - 1;
            if (phase === 'continent') {
                const btns = continentContainer.querySelectorAll('.choice-button');
                if (btns[idx] && !btns[idx].disabled) { checkContinent(continents[idx], btns[idx]); e.preventDefault(); }
            } else if (phase === 'capital') {
                const btns = capitalContainer.querySelectorAll('.choice-button');
                if (btns[idx] && !btns[idx].disabled) { btns[idx].click(); e.preventDefault(); }
            }
        }
    });

    // Hover ticks for pointer users on the big buttons.
    document.addEventListener('mouseover', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('.choice-button, .action-button') : null;
        if (b && !b.disabled && gameStarted) audio.tick();
    });

    // ---- TV niceties: hide the idle cursor, hide caption on new round -----

    let cursorTimer = null;
    function wakeCursor() {
        document.body.classList.remove('cursor-hidden');
        if (cursorTimer) clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), 3500);
    }
    document.addEventListener('mousemove', wakeCursor);
    document.addEventListener('mousedown', wakeCursor);

    document.addEventListener('visibilitychange', () => {
        if (!gameStarted) return;
        if (document.hidden) audio.stopMusic();
        else if (musicEnabled) audio.startMusic();
    });

    // ---- Wire up ------------------------------------------------------------

    countryFlag.addEventListener('error', () => { countryFlag.hidden = true; });
    captionFlag.addEventListener('error', () => { captionFlag.hidden = true; });

    settingsButton.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
    settingsPanel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!isHidden(settingsPanel)) closeSettings(); });
    toggleMusicEl.addEventListener('click', () => setMusic(!musicEnabled));
    toggleSfxEl.addEventListener('click', () => setSfx(!sfxEnabled));
    fullscreenButton.addEventListener('click', () => { toggleFullscreen(); closeSettings(true); });
    resetButton.addEventListener('click', resetProgress);

    startButton.addEventListener('click', async () => {
        if (gameStarted) return;
        gameStarted = true;
        splashScreen.classList.add('fading');
        setTimeout(() => { splashScreen.style.display = 'none'; }, 500);
        gameContainer.classList.add('active');
        wakeCursor();
        await audio.unlock();
        audio.start();
        if (musicEnabled) audio.startMusic();
        initializeGame();
    });

    skipButton.addEventListener('click', skipCurrent);
    capitalButton.addEventListener('click', startCapitalRound);
    nextButton.addEventListener('click', advance);

    window.addEventListener('resize', () => stars.draw());

    syncSettingsUI();
    stars.draw();
    globe.init();
    // Warm the cache so the world is ready the moment Start is pressed.
    loadGeojson().catch(() => {});
})();
