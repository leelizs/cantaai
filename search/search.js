(() => {
  "use strict";

  const MAX_QUERY_LENGTH = 180;
  const SEARCH_TIMEOUT_MS = 22000;
  const ENDPOINTS = {
    searchMusic: "/.netlify/functions/search-music",
  };

  const DEFAULT_COVER =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
        <rect width="160" height="160" rx="22" fill="#17204a"/>
        <circle cx="80" cy="80" r="48" fill="#4f5ff7" opacity="0.45"/>
        <text x="80" y="91" text-anchor="middle" font-size="44" font-family="Arial, Helvetica, sans-serif" fill="#ffffff">♪</text>
      </svg>
    `);

  const app = {
    elements: null,
    state: {
      results: [],
      latestSearchId: 0,
      activeController: null,
      isLoading: false,
      lastQuery: "",
      lastUsedAi: false,
    },
  };

  /* =========================
     DOM
  ========================= */

  function getElements() {
    const byId = (id) => document.getElementById(id);

    const elements = {
      page: document.querySelector(".search-page"),
      searchForm: byId("searchForm"),
      searchInput: byId("searchInput"),
      searchButton: byId("searchButton"),
      statusText: byId("status"),
      resultsContainer: byId("results"),
    };

    const missingElements = Object.entries(elements).filter(
      ([, value]) => !value,
    );

    if (missingElements.length > 0) {
      console.error(
        "CantaAI Search: elementos obrigatórios não encontrados:",
        missingElements.map(([name]) => name).join(", "),
      );

      return null;
    }

    return elements;
  }

  function init() {
    const elements = getElements();

    if (!elements) {
      return;
    }

    app.elements = elements;

    bindEvents();
    hydrateQueryFromUrl();
    updateLoading(false);
    elements.page.classList.add("is-ready");
  }

  /* =========================
     Helpers
  ========================= */

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_QUERY_LENGTH);
  }

  function setStatus(message, type = "info") {
    const { statusText } = app.elements;

    statusText.textContent = message;
    statusText.dataset.status = type;
  }

  function updateLoading(isLoading) {
    const { searchButton, searchInput } = app.elements;

    app.state.isLoading = isLoading;

    searchButton.disabled = isLoading;
    searchButton.textContent = isLoading ? "Buscando..." : "Buscar música";
    searchButton.classList.toggle("is-loading", isLoading);
    searchButton.setAttribute("aria-busy", String(isLoading));

    searchInput.disabled = isLoading;
  }

  function createElement(tag, className = "", textContent = undefined) {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (textContent !== undefined) {
      element.textContent = textContent;
    }

    return element;
  }

  function clearResults() {
    pauseAllPreviewAudios();
    app.elements.resultsContainer.replaceChildren();
  }

  function clampNumber(value, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return min;
    }

    return Math.min(Math.max(number, min), max);
  }

  function isSafeHttpUrl(url) {
    try {
      const parsedUrl = new URL(url, window.location.origin);
      return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function createSafeExternalLink(label, url) {
    if (!isSafeHttpUrl(url)) {
      return null;
    }

    const parsedUrl = new URL(url, window.location.origin);
    const link = document.createElement("a");

    link.href = parsedUrl.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;

    return link;
  }

  function getFriendlyBackendError(message) {
    const text = String(message || "").toLowerCase();

    if (!navigator.onLine) {
      return "Você está sem conexão. Conecte-se à internet e tente novamente.";
    }

    if (
      text.includes("quota") ||
      text.includes("resource_exhausted") ||
      text.includes("rate limit") ||
      text.includes("429")
    ) {
      return "Estamos com muitas buscas agora. Tente novamente mais tarde.";
    }

    if (
      text.includes("abort") ||
      text.includes("timeout") ||
      text.includes("demorou")
    ) {
      return "A busca demorou demais. Tente novamente com menos palavras.";
    }

    if (text.includes("failed to fetch") || text.includes("network")) {
      return "Não conseguimos conectar ao servidor do CantaAI. Verifique sua internet e tente novamente.";
    }

    return (
      message ||
      "Não conseguimos buscar agora. Tente novamente em alguns segundos."
    );
  }

  async function readResponseJson(response) {
    const text = await response.text();

    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return {};
    }
  }

  async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = SEARCH_TIMEOUT_MS,
  ) {
    if (!navigator.onLine) {
      throw new Error("Você está sem conexão.");
    }

    const externalSignal = options.signal;

    if (!window.AbortController) {
      return fetch(url, options);
    }

    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(
      () => timeoutController.abort(),
      timeoutMs,
    );

    function abortByExternalSignal() {
      timeoutController.abort();
    }

    if (externalSignal) {
      if (externalSignal.aborted) {
        timeoutController.abort();
      } else {
        externalSignal.addEventListener("abort", abortByExternalSignal, {
          once: true,
        });
      }
    }

    try {
      return await fetch(url, {
        ...options,
        signal: timeoutController.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);

      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortByExternalSignal);
      }
    }
  }

  function updateUrlQuery(query) {
    const url = new URL(window.location.href);

    if (query) {
      url.searchParams.set("q", query);
    } else {
      url.searchParams.delete("q");
    }

    window.history.replaceState({}, "", url);
  }

  function hydrateQueryFromUrl() {
    const url = new URL(window.location.href);
    const query = normalizeText(url.searchParams.get("q"));

    if (!query) {
      setStatus("Digite algo para começar.");
      return;
    }

    app.elements.searchInput.value = query;
    handleSearch({ useAi: false });
  }

  /* =========================
     Player customizado
  ========================= */

  function resetPreviewButtons() {
    document.querySelectorAll(".preview-button").forEach((button) => {
      button.textContent = "▶ Ouvir prévia";
      button.classList.remove("is-playing");
    });
  }

  function pauseAllPreviewAudios() {
    document.querySelectorAll(".preview-audio").forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });

    resetPreviewButtons();
  }

  function pauseOtherPreviewAudios(currentAudio) {
    document.querySelectorAll(".preview-audio").forEach((audio) => {
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
      setStatus("Não foi possível tocar essa prévia agora.", "warning");
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

  function createPreviewPlayer(previewUrl) {
    const previewPlayer = createElement("div", "preview-player");

    if (!isSafeHttpUrl(previewUrl)) {
      previewPlayer.appendChild(
        createElement("span", "no-preview", "Prévia indisponível"),
      );
      return previewPlayer;
    }

    const previewButton = createElement(
      "button",
      "preview-button",
      "▶ Ouvir prévia",
    );

    previewButton.type = "button";

    const audio = document.createElement("audio");
    audio.src = previewUrl;
    audio.className = "preview-audio";
    audio.preload = "none";

    previewButton.addEventListener("click", () => {
      togglePreviewAudio(audio, previewButton);
    });

    audio.addEventListener("ended", handlePreviewEnded);
    audio.addEventListener("pause", handlePreviewEnded);

    previewPlayer.append(previewButton, audio);

    return previewPlayer;
  }

  /* =========================
     Backend
  ========================= */

  async function searchMusic(query, options = {}) {
    const { useAi = false, signal = null } = options;
    const params = new URLSearchParams({
      query,
      useAi: String(useAi),
    });

    const response = await fetchWithTimeout(
      `${ENDPOINTS.searchMusic}?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
        signal,
      },
      SEARCH_TIMEOUT_MS,
    );

    const data = await readResponseJson(response);

    if (!response.ok) {
      throw new Error(
        data.userMessage || data.error || "Erro ao buscar músicas no backend.",
      );
    }

    return Array.isArray(data.results) ? data.results : [];
  }

  /* =========================
     Renderização
  ========================= */

  function renderEmptyState(title, description, action = null) {
    clearResults();

    app.elements.resultsContainer.appendChild(
      createInfoCard(title, description, action),
    );
  }

  function createInfoCard(title, description, action = null) {
    const card = createElement("article", "music-card music-card--info");
    const info = createElement("div", "music-info");

    const cardTitle = createElement("h3", "", title);
    const cardDescription = createElement("p", "", description);

    info.append(cardTitle, cardDescription);

    if (action) {
      const actions = createElement("div", "music-actions");
      const button = createElement("button", "", action.label);

      button.type = "button";
      button.addEventListener("click", action.onClick);

      actions.appendChild(button);
      info.appendChild(actions);
    }

    card.appendChild(info);

    return card;
  }

  function createMusicCard(music, isBestGuess = false) {
    const card = createElement("article", "music-card");

    if (isBestGuess) {
      card.classList.add("best-card");
    }

    const titleText = music.title || "Título desconhecido";
    const artistText =
      music.artist?.name || music.artist || "Artista desconhecido";

    const cover = document.createElement("img");
    cover.src =
      music.album?.cover_medium || music.album?.cover || DEFAULT_COVER;
    cover.alt = `Capa da música ${titleText}`;
    cover.loading = "lazy";
    cover.decoding = "async";
    cover.addEventListener(
      "error",
      () => {
        cover.src = DEFAULT_COVER;
        cover.alt = "Capa indisponível";
      },
      { once: true },
    );

    const info = createElement("div", "music-info");

    if (isBestGuess) {
      const badge = createElement("span", "best-guess", "Melhor palpite");
      info.appendChild(badge);
    }

    const title = createElement("h3", "", titleText);
    const artist = createElement("p", "", artistText);

    const similarity = Math.round(clampNumber(music.similarity, 0, 99));
    const compatibility = createElement(
      "span",
      "music-compatibility",
      `Compatibilidade: ${similarity}%`,
    );

    const actions = createElement("div", "music-actions");

    if (music.preview) {
      actions.appendChild(createPreviewPlayer(music.preview));
    } else {
      actions.appendChild(
        createElement("span", "no-preview", "Prévia indisponível"),
      );
    }

    const deezerLink = music.link
      ? createSafeExternalLink("Abrir na Deezer", music.link)
      : null;

    if (deezerLink) {
      actions.appendChild(deezerLink);
    }

    if (isBestGuess) {
      const rejectButton = createElement(
        "button",
        "reject-button",
        "Não é essa",
      );
      rejectButton.type = "button";
      rejectButton.addEventListener("click", rejectBestGuess);
      actions.appendChild(rejectButton);
    }

    info.append(title, artist, compatibility, actions);
    card.append(cover, info);

    return card;
  }

  function createAiRefinementCard(query) {
    return createInfoCard(
      "Quer uma busca mais precisa com IA?",
      "A primeira busca não usa IA. Se o resultado não ficou bom, você pode pedir para o CantaAI refinar usando IA.",
      {
        label: "Refinar com IA",
        onClick: () => handleSearch({ query, useAi: true }),
      },
    );
  }

  function renderResults(musics, options = {}) {
    const { query = "", canRefineWithAi = false } = options;

    clearResults();

    if (musics.length === 0) {
      const emptyCard = createInfoCard(
        "Nenhuma música encontrada",
        "Tente escrever de outro jeito, usar menos palavras ou colocar um trecho da letra.",
      );

      app.elements.resultsContainer.appendChild(emptyCard);

      if (canRefineWithAi && query) {
        app.elements.resultsContainer.appendChild(
          createAiRefinementCard(query),
        );
      }

      return;
    }

    const bestGuess = musics[0];
    const otherResults = musics.slice(1);

    const bestTitle = createElement("h2", "section-title", "🎯 Melhor palpite");

    app.elements.resultsContainer.appendChild(bestTitle);
    app.elements.resultsContainer.appendChild(createMusicCard(bestGuess, true));

    if (otherResults.length > 0) {
      const otherTitle = createElement(
        "h2",
        "section-title",
        "Outras possibilidades",
      );

      app.elements.resultsContainer.appendChild(otherTitle);

      otherResults.forEach((music) => {
        app.elements.resultsContainer.appendChild(createMusicCard(music));
      });
    }

    if (canRefineWithAi && query) {
      app.elements.resultsContainer.appendChild(createAiRefinementCard(query));
    }
  }

  /* =========================
     Ações do usuário
  ========================= */

  function rejectBestGuess() {
    pauseAllPreviewAudios();

    if (app.state.results.length <= 1) {
      app.state.results = [];

      renderEmptyState(
        "Acabaram as possibilidades",
        "Tente escrever de outro jeito, usar mais palavras da música ou refinar com IA.",
        app.state.lastQuery && !app.state.lastUsedAi
          ? {
              label: "Refinar com IA",
              onClick: () =>
                handleSearch({ query: app.state.lastQuery, useAi: true }),
            }
          : null,
      );

      setStatus("Não temos outras possibilidades para essa busca.", "warning");
      return;
    }

    app.state.results = app.state.results.slice(1);

    setStatus("Tudo bem. Mostrando outro possível resultado.");
    renderResults(app.state.results, {
      query: app.state.lastQuery,
      canRefineWithAi: !app.state.lastUsedAi,
    });
  }

  async function handleSearch(options = {}) {
    const query = normalizeText(
      options.query ?? app.elements.searchInput.value,
    );
    const useAi = Boolean(options.useAi);

    app.elements.searchInput.value = query;

    if (!query) {
      app.state.results = [];
      app.state.lastQuery = "";
      app.state.lastUsedAi = false;
      updateUrlQuery("");
      clearResults();
      setStatus("Digite algo para começar.", "warning");
      app.elements.searchInput.focus();
      return;
    }

    if (app.state.activeController) {
      app.state.activeController.abort();
    }

    const controller = window.AbortController ? new AbortController() : null;
    const searchId = app.state.latestSearchId + 1;

    app.state.latestSearchId = searchId;
    app.state.activeController = controller;
    app.state.lastQuery = query;
    app.state.lastUsedAi = useAi;

    updateLoading(true);
    clearResults();
    updateUrlQuery(query);

    setStatus(
      useAi
        ? `Refinando com IA: "${query}"...`
        : `Buscando músicas parecidas com: "${query}"...`,
    );

    try {
      const musics = await searchMusic(query, {
        useAi,
        signal: controller?.signal,
      });

      if (app.state.latestSearchId !== searchId) {
        return;
      }

      app.state.results = musics;

      setStatus(
        musics.length === 0
          ? "Nenhum resultado encontrado."
          : `Encontramos ${musics.length} possível(is) resultado(s).`,
        musics.length === 0 ? "warning" : "success",
      );

      renderResults(app.state.results, {
        query,
        canRefineWithAi: !useAi,
      });
    } catch (error) {
      if (
        error.name === "AbortError" &&
        app.state.latestSearchId !== searchId
      ) {
        return;
      }

      console.log(error);

      const friendlyMessage = getFriendlyBackendError(error.message);

      setStatus(friendlyMessage, "error");

      renderEmptyState(
        "Algo deu errado",
        friendlyMessage,
        !useAi
          ? {
              label: "Tentar com IA",
              onClick: () => handleSearch({ query, useAi: true }),
            }
          : null,
      );
    } finally {
      if (app.state.latestSearchId === searchId) {
        updateLoading(false);
        app.state.activeController = null;
      }
    }
  }

  /* =========================
     Eventos
  ========================= */

  function bindEvents() {
    const { searchForm, searchInput } = app.elements;

    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleSearch({ useAi: false });
    });

    searchInput.addEventListener("input", () => {
      if (searchInput.value.length > MAX_QUERY_LENGTH) {
        searchInput.value = searchInput.value.slice(0, MAX_QUERY_LENGTH);
      }
    });

    window.addEventListener("beforeunload", handleBeforeUnload);
  }

  function handleBeforeUnload() {
    pauseAllPreviewAudios();

    if (app.state.activeController) {
      app.state.activeController.abort();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
