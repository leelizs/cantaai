const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  statusText: document.getElementById("status"),
  resultsContainer: document.getElementById("results"),
};

const DEEZER_API_URL = "https://api.deezer.com/search";
const DEEZER_LIMIT = 10;
const MAX_SEARCH_TERMS = 5;
const MAX_RESULTS = 12;

let state = {
  results: [],
  latestSearchId: 0,
  isLoading: false,
};

/* =========================
   Helpers
========================= */

function normalizeText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeHTML(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setLoading(isLoading) {
  state.isLoading = isLoading;
  elements.searchButton.disabled = isLoading;
  elements.searchButton.textContent = isLoading
    ? "Buscando..."
    : "Buscar música";
}

function clearResults() {
  elements.resultsContainer.innerHTML = "";
}

function createElement(tag, className, textContent) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
}

function pauseOtherAudios(currentAudio) {
  const audios = document.querySelectorAll("audio");

  audios.forEach((audio) => {
    if (audio !== currentAudio) {
      audio.pause();
      audio.currentTime = 0;
    }
  });
}

function handleAudioPlay(event) {
  pauseOtherAudios(event.currentTarget);
}

/* =========================
   Algoritmo de Similaridade
========================= */

function levenshtein(textA, textB) {
  const a = normalizeText(textA);
  const b = normalizeText(textB);

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const hasSameLetter = b.charAt(i - 1) === a.charAt(j - 1);

      matrix[i][j] = hasSameLetter
        ? matrix[i - 1][j - 1]
        : Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
    }
  }

  return matrix[b.length][a.length];
}

function getWordSimilarity(wordA, wordB) {
  const a = normalizeText(wordA);
  const b = normalizeText(wordB);

  if (!a || !b) {
    return 0;
  }

  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

function calculateSimilarity(query, music) {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(music.title);
  const artist = normalizeText(music.artist.name);
  const fullText = `${title} ${artist}`;

  let score = 0;

  if (title === normalizedQuery) {
    score += 100;
  }

  if (title.includes(normalizedQuery)) {
    score += 90;
  }

  if (fullText.includes(normalizedQuery)) {
    score += 80;
  }

  if (artist.includes(normalizedQuery)) {
    score += 50;
  }

  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = title.split(" ").filter(Boolean);
  const artistWords = artist.split(" ").filter(Boolean);
  const allMusicWords = [...titleWords, ...artistWords];

  queryWords.forEach((queryWord) => {
    let bestWordScore = 0;

    allMusicWords.forEach((musicWord) => {
      const similarity = getWordSimilarity(queryWord, musicWord);

      if (similarity > bestWordScore) {
        bestWordScore = similarity;
      }
    });

    if (bestWordScore >= 0.8) {
      score += 35;
    } else if (bestWordScore >= 0.65) {
      score += 25;
    } else if (bestWordScore >= 0.5) {
      score += 12;
    }
  });

  const fullTitleSimilarity = getWordSimilarity(normalizedQuery, title);

  if (fullTitleSimilarity >= 0.8) {
    score += 80;
  } else if (fullTitleSimilarity >= 0.65) {
    score += 50;
  } else if (fullTitleSimilarity >= 0.5) {
    score += 25;
  }

  if (music.rank) {
    score += Math.min(music.rank / 100000, 15);
  }

  return Math.min(Math.round(score), 99);
}

/* =========================
   Deezer API
========================= */

function searchDeezerWithJsonp(term) {
  return new Promise((resolve, reject) => {
    const callbackName = `deezerCallback_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const script = document.createElement("script");

    window[callbackName] = function (data) {
      delete window[callbackName];
      script.remove();
      resolve(data);
    };

    script.src = `${DEEZER_API_URL}?q=${encodeURIComponent(term)}&limit=${DEEZER_LIMIT}&output=jsonp&callback=${callbackName}`;

    script.onerror = function () {
      delete window[callbackName];
      script.remove();
      reject(new Error("Erro ao buscar na Deezer"));
    };

    document.body.appendChild(script);
  });
}

function createSearchTerms(query) {
  const normalizedQuery = normalizeText(query);

  const words = normalizedQuery.split(" ").filter((word) => word.length >= 3);

  const terms = [query];

  words.forEach((word) => {
    if (!terms.includes(word)) {
      terms.push(word);
    }
  });

  return terms.slice(0, MAX_SEARCH_TERMS);
}

function removeDuplicatedMusics(musics) {
  const uniqueMusics = new Map();

  musics.forEach((music) => {
    if (!uniqueMusics.has(music.id)) {
      uniqueMusics.set(music.id, music);
    }
  });

  return Array.from(uniqueMusics.values());
}

async function searchDeezer(query) {
  const url = `/.netlify/functions/search-music?query=${encodeURIComponent(query)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Erro ao buscar músicas no backend.");
  }

  const data = await response.json();

  return data.results || [];
}

/* =========================
   Renderização
========================= */

function renderEmptyState(title, description) {
  clearResults();

  const card = createElement("article", "music-card");
  const info = createElement("div", "music-info");

  const cardTitle = createElement("h3", "", title);
  const cardDescription = createElement("p", "", description);

  info.append(cardTitle, cardDescription);
  card.appendChild(info);
  elements.resultsContainer.appendChild(card);
}

function createMusicCard(music, isBestGuess = false) {
  const card = createElement("article", "music-card");

  if (isBestGuess) {
    card.classList.add("best-card");
  }

  const cover = document.createElement("img");
  cover.src = music.album?.cover_medium || "https://via.placeholder.com/100";
  cover.alt = `Capa da música ${escapeHTML(music.title)}`;

  const info = createElement("div", "music-info");

  if (isBestGuess) {
    const badge = createElement("span", "best-guess", "Melhor palpite");
    info.appendChild(badge);
  }

  const title = createElement("h3", "", music.title);
  const artist = createElement("p", "", music.artist.name);
  const chance = createElement(
    "span",
    "",
    `Chance de ser essa: ${Math.min(music.similarity, 99)}%`,
  );

  const actions = createElement("div", "music-actions");

  if (music.preview) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = music.preview;
    audio.addEventListener("play", handleAudioPlay);
    actions.appendChild(audio);
  } else {
    const noPreview = createElement("span", "", "Prévia indisponível");
    actions.appendChild(noPreview);
  }

  if (music.link) {
    const deezerLink = document.createElement("a");
    deezerLink.href = music.link;
    deezerLink.target = "_blank";
    deezerLink.rel = "noopener noreferrer";
    deezerLink.textContent = "Abrir na Deezer";
    actions.appendChild(deezerLink);
  }

  if (isBestGuess) {
    const rejectButton = createElement("button", "reject-button", "Não é essa");
    rejectButton.type = "button";
    rejectButton.addEventListener("click", rejectBestGuess);
    actions.appendChild(rejectButton);
  }

  info.append(title, artist, chance, actions);
  card.append(cover, info);

  return card;
}

function renderResults(musics) {
  clearResults();

  if (musics.length === 0) {
    renderEmptyState(
      "Nenhuma música encontrada",
      "Tente escrever de outro jeito ou usar uma palavra da letra.",
    );
    return;
  }

  const bestGuess = musics[0];
  const otherResults = musics.slice(1);

  const bestTitle = createElement("h2", "section-title", "🎯 Melhor palpite");

  elements.resultsContainer.appendChild(bestTitle);
  elements.resultsContainer.appendChild(createMusicCard(bestGuess, true));

  if (otherResults.length > 0) {
    const otherTitle = createElement(
      "h2",
      "section-title",
      "Outras possibilidades",
    );

    elements.resultsContainer.appendChild(otherTitle);

    otherResults.forEach((music) => {
      elements.resultsContainer.appendChild(createMusicCard(music));
    });
  }
}

/* =========================
   Ações do usuário
========================= */

function rejectBestGuess() {
  if (state.results.length <= 1) {
    state.results = [];

    renderEmptyState(
      "Acabaram as possibilidades",
      "Tente escrever de outro jeito ou usar mais palavras da música.",
    );

    setStatus("Não temos outras possibilidades para essa busca.");
    return;
  }

  state.results = state.results.slice(1);

  setStatus("Tudo bem. Mostrando outro possível resultado.");
  renderResults(state.results);
}

async function handleSearch() {
  const query = elements.searchInput.value.trim();

  if (!query) {
    state.results = [];
    clearResults();
    setStatus("Digite algo para começar.");
    return;
  }

  const searchId = Date.now();
  state.latestSearchId = searchId;

  setLoading(true);
  clearResults();
  setStatus("Buscando músicas parecidas...");

  try {
    const musics = await searchDeezer(query);

    if (state.latestSearchId !== searchId) {
      return;
    }

    state.results = musics;

    if (musics.length === 0) {
      setStatus("Nenhum resultado encontrado.");
    } else {
      setStatus(`Encontramos ${musics.length} possíveis resultado(s).`);
    }

    renderResults(state.results);
  } catch (error) {
    console.log(error);
    setStatus("Erro ao buscar músicas. Tente novamente.");
    renderEmptyState(
      "Algo deu errado",
      "Não conseguimos buscar agora. Tente novamente em alguns segundos.",
    );
  } finally {
    if (state.latestSearchId === searchId) {
      setLoading(false);
    }
  }
}

/* =========================
   Eventos
========================= */

elements.searchButton.addEventListener("click", handleSearch);

elements.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleSearch();
  }
});
