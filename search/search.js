const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  statusText: document.getElementById("status"),
  resultsContainer: document.getElementById("results"),
};

let state = {
  results: [],
  latestSearchId: 0,
  isLoading: false,
};

/* =========================
   Helpers
========================= */

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
  pauseAllPreviewAudios();
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

/* =========================
   Player customizado
========================= */

function resetPreviewButtons() {
  const previewButtons = document.querySelectorAll(".preview-button");

  previewButtons.forEach((button) => {
    button.textContent = "▶ Ouvir prévia";
    button.classList.remove("is-playing");
  });
}

function pauseAllPreviewAudios() {
  const audios = document.querySelectorAll(".preview-audio");

  audios.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });

  resetPreviewButtons();
}

function pauseOtherPreviewAudios(currentAudio) {
  const audios = document.querySelectorAll(".preview-audio");

  audios.forEach((audio) => {
    if (audio !== currentAudio) {
      audio.pause();
      audio.currentTime = 0;
    }
  });

  resetPreviewButtons();
}

async function togglePreviewAudio(audio, button) {
  try {
    if (audio.paused) {
      pauseOtherPreviewAudios(audio);

      await audio.play();

      button.textContent = "⏸ Pausar prévia";
      button.classList.add("is-playing");
      return;
    }

    audio.pause();
    button.textContent = "▶ Ouvir prévia";
    button.classList.remove("is-playing");
  } catch (error) {
    console.log("Erro ao tocar prévia:", error);
    setStatus("Não foi possível tocar essa prévia agora.");
  }
}

function handlePreviewEnded(event) {
  const audio = event.currentTarget;
  const player = audio.closest(".preview-player");
  const button = player?.querySelector(".preview-button");

  if (button) {
    button.textContent = "▶ Ouvir prévia";
    button.classList.remove("is-playing");
  }
}

/* =========================
   Backend
========================= */

async function searchDeezer(query) {
  const url = `/.netlify/functions/search-music?query=${encodeURIComponent(
    query,
  )}`;

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

function createPreviewPlayer(music) {
  const previewPlayer = createElement("div", "preview-player");

  const previewButton = createElement(
    "button",
    "preview-button",
    "▶ Ouvir prévia",
  );

  previewButton.type = "button";

  const audio = document.createElement("audio");
  audio.src = music.preview;
  audio.className = "preview-audio";
  audio.preload = "none";

  previewButton.addEventListener("click", () => {
    togglePreviewAudio(audio, previewButton);
  });

  audio.addEventListener("ended", handlePreviewEnded);

  previewPlayer.append(previewButton, audio);

  return previewPlayer;
}

function createMusicCard(music, isBestGuess = false) {
  const card = createElement("article", "music-card");

  if (isBestGuess) {
    card.classList.add("best-card");
  }

  const cover = document.createElement("img");
  cover.src = music.album?.cover_medium || "https://via.placeholder.com/100";
  cover.alt = `Capa da música ${music.title}`;

  const info = createElement("div", "music-info");

  if (isBestGuess) {
    const badge = createElement("span", "best-guess", "Melhor palpite");
    info.appendChild(badge);
  }

  const title = createElement("h3", "", music.title);
  const artist = createElement("p", "", music.artist.name);

  const compatibility = createElement(
    "span",
    "",
    `Compatibilidade: ${Math.min(music.similarity, 99)}%`,
  );

  const actions = createElement("div", "music-actions");

  if (music.preview) {
    actions.appendChild(createPreviewPlayer(music));
  } else {
    const noPreview = createElement(
      "span",
      "no-preview",
      "Prévia indisponível",
    );
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

  info.append(title, artist, compatibility, actions);
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
  pauseAllPreviewAudios();

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
