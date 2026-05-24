(function () {
    'use strict';

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

    countryFlag.addEventListener('error', () => {
        // Hide rather than show a broken-image icon if the flag CDN fails.
        countryFlag.hidden = true;
    });

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
