(function () {
    'use strict';

    const COUNTRY_CACHE_KEY = 'geography-game-country-data-v1';
    const COUNTRY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    const continents = ["Africa", "Asia", "Europe", "North America", "South America", "Australia", "Antarctica"];

    const regionMapping = {
        'Africa': 'Africa',
        'Americas': '', // handled via subregion
        'Antarctic': 'Antarctica',
        'Asia': 'Asia',
        'Europe': 'Europe',
        'Oceania': 'Australia'
    };

    const subregionMapping = {
        'Northern America': 'North America',
        'Caribbean': 'North America',
        'Central America': 'North America',
        'South America': 'South America'
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

    let countryData = [];
    let queue = [];
    let currentCountry = null;
    let map = null;
    let countryLayer = null;
    let gameInitialized = false;
    let firstTryWrong = false;
    let score = 0;
    let attempts = 0;
    let streak = 0;
    let bestStreak = 0;

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

            fetch('custom.geo.json')
                .then(response => response.json())
                .then(geojsonData => countryLayer.addGeoJson(geojsonData))
                .catch(error => console.error('Error loading custom.geo.json:', error));
        } catch (error) {
            console.error('Error initializing map:', error);
            const mapElement = document.getElementById("map");
            if (mapElement) mapElement.innerText = "Map unavailable, but you can still play.";
        }
    }

    function defaultFeatureStyle() {
        return {
            fillColor: 'gray',
            strokeColor: 'black',
            strokeWeight: 1,
            fillOpacity: 0.5
        };
    }

    function loadCachedCountryData() {
        try {
            const raw = localStorage.getItem(COUNTRY_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) return null;
            if (typeof parsed.savedAt !== 'number') return null;
            if (Date.now() - parsed.savedAt > COUNTRY_CACHE_TTL_MS) return null;
            return parsed.data;
        } catch (e) {
            return null;
        }
    }

    function saveCachedCountryData(data) {
        try {
            localStorage.setItem(COUNTRY_CACHE_KEY, JSON.stringify({
                savedAt: Date.now(),
                data: data
            }));
        } catch (e) {
            // ignore quota / private-mode errors
        }
    }

    function processCountries(data) {
        const out = [];
        data.forEach(country => {
            const name = country && country.name && country.name.common;
            const cca3 = country && country.cca3;
            const region = country && country.region;
            const subregion = country && country.subregion;
            const flags = country && country.flags;
            if (!name || !region || !flags) return;

            let continent = regionMapping[region];
            if (continent === undefined) return;
            if (continent === '') {
                continent = subregionMapping[subregion] || 'North America';
            }

            const flagUrl = flags.svg || flags.png || '';
            if (!flagUrl) return;

            out.push({
                country: name,
                code: cca3 || null,
                continent: continent,
                flagUrl: flagUrl
            });
        });
        return out;
    }

    function loadCountryData() {
        const cached = loadCachedCountryData();
        if (cached) {
            countryData = cached;
            startGame();
            return;
        }

        // restcountries /all requires `fields` (changed late 2024); without it returns HTTP 400.
        fetch('https://restcountries.com/v3.1/all?fields=name,cca3,region,subregion,flags')
            .then(response => {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(data => {
                countryData = processCountries(data);
                if (countryData.length > 0) saveCachedCountryData(countryData);
                startGame();
            })
            .catch(error => {
                console.error('Error fetching country data:', error);
                countryDisplay.innerText = "Failed to load country data.";
            });
    }

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

    function updateScoreboard() {
        scoreboard.innerText =
            'Score: ' + score + '/' + attempts +
            ' · Streak: ' + streak +
            ' (Best: ' + bestStreak + ')';
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
            if (!firstTryWrong) {
                score++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
            } else {
                streak = 0;
            }
            resultDisplay.innerText = "Correct!";
            resultDisplay.style.color = "green";
            button.classList.add('correct');
            playConfetti();
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
        }
    }

    function skipCurrent() {
        if (!currentCountry) return;
        if (!firstTryWrong) streak = 0;
        firstTryWrong = true;
        resultDisplay.innerText = "The answer is " + currentCountry.continent + ".";
        resultDisplay.style.color = "#444";
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(b => {
            if (b.innerText === currentCountry.continent) b.classList.add('correct');
        });
        finishRound();
    }

    function createButtons() {
        continentButtonsContainer.innerHTML = '';
        continents.forEach(continent => {
            const button = document.createElement("button");
            button.type = "button";
            button.classList.add("continent-button");
            button.innerText = continent;
            button.addEventListener('click', () => checkAnswer(continent, button));
            continentButtonsContainer.appendChild(button);
        });
    }

    function resetButtons() {
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(button => {
            button.disabled = false;
            button.classList.remove('incorrect', 'correct');
        });
    }

    function disableAllButtons() {
        const buttons = continentButtonsContainer.querySelectorAll('.continent-button');
        buttons.forEach(button => { button.disabled = true; });
    }

    function highlightCountry(country) {
        if (!countryLayer || !country) return;

        // Match on ISO 3-letter code; the geojson's `name` differs from
        // restcountries `name.common` for many countries (e.g. "United
        // States of America" vs "United States", "Dominican Rep.").
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

    function playConfetti() {
        if (typeof confetti !== 'function') return;
        confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
        });
    }

    function initializeGame() {
        if (gameInitialized) return;
        gameInitialized = true;
        createButtons();
        loadCountryData();
    }

    startButton.addEventListener("click", () => {
        splashScreen.style.display = "none";
        gameContainer.style.display = "block";
        initializeGame();
    });

    skipButton.addEventListener("click", skipCurrent);
    nextButton.addEventListener("click", startGame);

    // Google Maps loads with ?callback=initMap and expects a global.
    window.initMap = initMap;
})();
