const elements = {
  startButton: document.getElementById("startRecordButton"),
  stopButton: document.getElementById("stopRecordButton"),
  resetButton: document.getElementById("resetRecordButton"),
  analyzeButton: document.getElementById("analyzeButton"),
  audioPreview: document.getElementById("audioPreview"),
  statusText: document.getElementById("status"),
  recordTimer: document.getElementById("recordTimer"),
  recorderVisual: document.getElementById("recorderVisual"),
  resultsContainer: document.getElementById("recordResults"),
  modeHint: document.getElementById("modeHint"),
  modeInputs: document.querySelectorAll('input[name="recordMode"]'),
  modeCards: document.querySelectorAll(".mode-card"),
  tipOneTitle: document.getElementById("tipOneTitle"),
  tipOneText: document.getElementById("tipOneText"),
  tipTwoTitle: document.getElementById("tipTwoTitle"),
  tipTwoText: document.getElementById("tipTwoText"),
  tipThreeTitle: document.getElementById("tipThreeTitle"),
  tipThreeText: document.getElementById("tipThreeText"),
};

const RECORDING_MODES = {
  speech: {
    label: "Falar o que lembra",
    minSeconds: 2,
    maxSeconds: 8,
    hint: 'Fale algo como "bad michael jackson", "smooth criminal" ou um trecho da letra.',
    startStatus: "Gravando... fale o nome, artista ou trecho que você lembra.",
    readyStatus: "Gravando... você já pode parar. Fale só o essencial.",
    finishedStatus: "Gravação finalizada. Você pode ouvir antes de analisar.",
    autoFinishedStatus:
      "Gravação finalizada automaticamente. Você pode ouvir antes de analisar.",
    shortStatus: "Fale por pelo menos 2 segundos para analisarmos melhor.",
    analyzingStatus: "Interpretando sua fala e buscando músicas parecidas...",
    tips: {
      oneTitle: "Fale de forma simples",
      oneText:
        "Diga o nome da música, artista ou um pedaço da letra. Não precisa cantar perfeito.",
      twoTitle: "Evite frases longas",
      twoText:
        "Algo curto como “bad michael jackson” funciona melhor que uma explicação grande.",
      threeTitle: "Grave de 2 a 8 segundos",
      threeText:
        "Para fala, uma gravação curta e clara costuma funcionar melhor.",
    },
  },

  humming: {
    label: "Cantarolar melodia",
    minSeconds: 10,
    maxSeconds: 15,
    hint: "Cantarole o refrão com “hmmm” ou “nanana”. Não fale o nome da música neste modo.",
    startStatus:
      "Gravando... cantarole a melodia principal, de preferência o refrão.",
    readyStatus:
      "Gravando... você já pode parar, mas quanto mais claro o refrão melhor.",
    finishedStatus:
      "Gravação finalizada. Vamos comparar sua melodia com a base de músicas.",
    autoFinishedStatus:
      "Gravação finalizada automaticamente em 15 segundos. Você pode analisar.",
    shortStatus:
      "Cantarolado precisa de pelo menos 10 segundos para ter mais chance.",
    analyzingStatus: "Analisando melodia com reconhecimento por humming...",
    tips: {
      oneTitle: "Cantarole o refrão",
      oneText:
        "Introduções e batidas são mais difíceis. O refrão geralmente funciona melhor.",
      twoTitle: "Não fale palavras",
      twoText:
        "Use “hmmm”, “nanana” ou assobio. Se souber o nome, use o modo Falar.",
      threeTitle: "Grave de 10 a 15 segundos",
      threeText:
        "Cantarolar é mais difícil que falar. Um trecho maior melhora a chance.",
    },
  },
};

const state = {
  mode: "speech",
  mediaStream: null,
  mediaRecorder: null,
  audioChunks: [],
  audioBlob: null,
  audioUrl: null,
  timerInterval: null,
  maxRecordTimeout: null,
  startedAt: null,
  recordedDurationSeconds: 0,
  isRecording: false,
  isAnalyzing: false,
};

/* =========================
   Helpers
========================= */

function getModeConfig() {
  return RECORDING_MODES[state.mode];
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function formatTime(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function getElapsedSeconds() {
  if (!state.startedAt) {
    return 0;
  }

  return Math.floor((Date.now() - state.startedAt) / 1000);
}

function updateTimer() {
  if (!state.startedAt) {
    elements.recordTimer.textContent = "00:00";
    return;
  }

  const { maxSeconds } = getModeConfig();
  const elapsedSeconds = Math.min(getElapsedSeconds(), maxSeconds);

  elements.recordTimer.textContent = formatTime(elapsedSeconds);
}

function startTimer() {
  state.startedAt = Date.now();
  state.recordedDurationSeconds = 0;

  updateTimer();

  state.timerInterval = setInterval(() => {
    const { minSeconds, maxSeconds, readyStatus } = getModeConfig();

    updateTimer();

    const elapsedSeconds = getElapsedSeconds();
    const remainingSeconds = Math.max(maxSeconds - elapsedSeconds, 0);

    if (elapsedSeconds < minSeconds) {
      setStatus(`Gravando... continue por pelo menos ${minSeconds} segundos.`);
      return;
    }

    if (elapsedSeconds < maxSeconds) {
      setStatus(`${readyStatus} Tempo restante: ${remainingSeconds}s.`);
    }
  }, 500);
}

function stopTimer() {
  const { maxSeconds } = getModeConfig();

  if (state.startedAt) {
    state.recordedDurationSeconds = Math.min(getElapsedSeconds(), maxSeconds);
  }

  clearInterval(state.timerInterval);
  clearTimeout(state.maxRecordTimeout);

  state.timerInterval = null;
  state.maxRecordTimeout = null;
  state.startedAt = null;
}

function setRecordingUI(isRecording) {
  state.isRecording = isRecording;

  elements.startButton.disabled = isRecording || state.isAnalyzing;
  elements.stopButton.disabled = !isRecording || state.isAnalyzing;
  elements.resetButton.disabled =
    isRecording || !state.audioBlob || state.isAnalyzing;
  elements.analyzeButton.disabled =
    isRecording || !state.audioBlob || state.isAnalyzing;

  elements.modeInputs.forEach((input) => {
    input.disabled = isRecording || state.isAnalyzing;
  });

  elements.recorderVisual.classList.toggle("is-recording", isRecording);
}

function setAnalyzingUI(isAnalyzing) {
  state.isAnalyzing = isAnalyzing;

  elements.startButton.disabled = isAnalyzing || state.isRecording;
  elements.stopButton.disabled = isAnalyzing || !state.isRecording;
  elements.resetButton.disabled =
    isAnalyzing || state.isRecording || !state.audioBlob;
  elements.analyzeButton.disabled =
    isAnalyzing || state.isRecording || !state.audioBlob;

  elements.modeInputs.forEach((input) => {
    input.disabled = isAnalyzing || state.isRecording;
  });

  elements.analyzeButton.textContent = isAnalyzing
    ? "Analisando..."
    : "Analisar gravação";
}

function clearAudioUrl() {
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
  }

  state.audioUrl = null;
}

function clearResults() {
  pauseAllPreviewAudios();
  elements.resultsContainer.innerHTML = "";
}

function resetAudioState() {
  clearAudioUrl();
  clearResults();

  state.audioChunks = [];
  state.audioBlob = null;
  state.recordedDurationSeconds = 0;

  elements.audioPreview.src = "";
  elements.audioPreview.hidden = true;
  elements.recordTimer.textContent = "00:00";
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

function getFriendlyMicrophoneError(error) {
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "Nenhum microfone foi encontrado. Conecte um fone com microfone ou teste pelo celular.";
  }

  if (
    error.name === "NotAllowedError" ||
    error.name === "PermissionDeniedError"
  ) {
    return "Permissão negada. Libere o microfone no navegador para gravar.";
  }

  if (error.name === "NotReadableError") {
    return "O microfone está sendo usado por outro aplicativo ou não pôde ser acessado.";
  }

  if (error.name === "SecurityError") {
    return "O navegador bloqueou o acesso ao microfone por segurança.";
  }

  return "Não foi possível acessar o microfone. Verifique as permissões do navegador.";
}

function getFriendlyBackendError(message) {
  const text = String(message || "").toLowerCase();

  if (
    text.includes("quota") ||
    text.includes("resource_exhausted") ||
    text.includes("rate limit") ||
    text.includes("429")
  ) {
    return "O limite diário da IA foi atingido. Tente novamente mais tarde ou use o modo Cantarolar.";
  }

  return (
    message ||
    "Não conseguimos analisar essa gravação agora. Tente novamente em alguns segundos."
  );
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      resolve(reader.result);
    };

    reader.onerror = () => {
      reject(new Error("Não foi possível ler o áudio gravado."));
    };

    reader.readAsDataURL(blob);
  });
}

/* =========================
   Modo de busca
========================= */

function updateModeUI() {
  const config = getModeConfig();

  elements.modeCards.forEach((card) => {
    const input = card.querySelector('input[name="recordMode"]');
    const isSelected = input?.value === state.mode;

    card.classList.toggle("is-selected", isSelected);
  });

  elements.modeHint.textContent = config.hint;

  elements.tipOneTitle.textContent = config.tips.oneTitle;
  elements.tipOneText.textContent = config.tips.oneText;
  elements.tipTwoTitle.textContent = config.tips.twoTitle;
  elements.tipTwoText.textContent = config.tips.twoText;
  elements.tipThreeTitle.textContent = config.tips.threeTitle;
  elements.tipThreeText.textContent = config.tips.threeText;

  setStatus("Clique em começar e permita o uso do microfone.");
}

function changeMode(mode) {
  if (!RECORDING_MODES[mode] || state.isRecording || state.isAnalyzing) {
    return;
  }

  state.mode = mode;
  resetAudioState();
  setRecordingUI(false);
  updateModeUI();
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

function createPreviewPlayer(previewUrl) {
  const previewPlayer = createElement("div", "preview-player");

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

  previewPlayer.append(previewButton, audio);

  return previewPlayer;
}

/* =========================
   Microfone
========================= */

async function requestMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Seu navegador não suporta gravação de áudio.");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: true,
  });
}

function getSupportedMimeType() {
  const mimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function createMediaRecorder(stream) {
  const mimeType = getSupportedMimeType();

  if (mimeType) {
    return new MediaRecorder(stream, { mimeType });
  }

  return new MediaRecorder(stream);
}

function stopMicrophoneTracks() {
  if (!state.mediaStream) {
    return;
  }

  state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
}

/* =========================
   Recorder
========================= */

async function startRecording() {
  const config = getModeConfig();

  try {
    resetAudioState();

    state.mediaStream = await requestMicrophone();
    state.mediaRecorder = createMediaRecorder(state.mediaStream);

    state.mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
    state.mediaRecorder.addEventListener("stop", handleRecordingStop);

    state.mediaRecorder.start();

    startTimer();
    setRecordingUI(true);

    state.maxRecordTimeout = setTimeout(() => {
      stopRecording({
        force: true,
        reason: "max-time",
      });
    }, config.maxSeconds * 1000);

    setStatus(
      `${config.startStatus} Grave entre ${config.minSeconds} e ${config.maxSeconds} segundos.`,
    );
  } catch (error) {
    console.log(error);

    stopTimer();
    stopMicrophoneTracks();

    setStatus(getFriendlyMicrophoneError(error));
    setRecordingUI(false);
  }
}

function stopRecording(options = {}) {
  const { force = false, reason = "manual" } = options;
  const config = getModeConfig();

  if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
    return;
  }

  const elapsedSeconds = getElapsedSeconds();

  if (!force && elapsedSeconds < config.minSeconds) {
    const remainingSeconds = config.minSeconds - elapsedSeconds;

    setStatus(`${config.shortStatus} Faltam ${remainingSeconds}s.`);

    return;
  }

  stopTimer();

  state.mediaRecorder.stop();
  setRecordingUI(false);

  if (reason === "max-time") {
    setStatus(config.autoFinishedStatus);
    return;
  }

  setStatus(config.finishedStatus);
}

function handleDataAvailable(event) {
  if (event.data && event.data.size > 0) {
    state.audioChunks.push(event.data);
  }
}

function handleRecordingStop() {
  const config = getModeConfig();
  const mimeType = state.mediaRecorder?.mimeType || "audio/webm";

  if (state.recordedDurationSeconds < config.minSeconds) {
    resetAudioState();
    stopMicrophoneTracks();
    setRecordingUI(false);

    setStatus(config.shortStatus);

    return;
  }

  state.audioBlob = new Blob(state.audioChunks, {
    type: mimeType,
  });

  clearAudioUrl();

  state.audioUrl = URL.createObjectURL(state.audioBlob);
  elements.audioPreview.src = state.audioUrl;
  elements.audioPreview.hidden = false;

  stopMicrophoneTracks();

  elements.resetButton.disabled = false;
  elements.analyzeButton.disabled = false;
}

async function resetRecording() {
  if (state.isRecording || state.isAnalyzing) {
    return;
  }

  resetAudioState();
  setRecordingUI(false);
  setStatus("Preparando nova gravação...");

  await startRecording();
}

/* =========================
   Busca textual fallback
========================= */

async function searchByText(query) {
  const url = `/.netlify/functions/search-music?query=${encodeURIComponent(
    query,
  )}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Erro ao buscar músicas por texto.");
  }

  const data = await response.json();

  return data.results || [];
}

/* =========================
   Renderização dos resultados
========================= */

function renderInfoCard(title, description, action = null) {
  clearResults();

  const card = createElement("article", "result-card result-card--info");
  const content = createElement("div", "result-card__content");

  const cardTitle = createElement("h3", "", title);
  const cardDescription = createElement("p", "", description);

  content.append(cardTitle, cardDescription);

  if (action) {
    const actions = createElement("div", "result-actions");
    const actionButton = createElement("button", "", action.label);

    actionButton.type = "button";
    actionButton.addEventListener("click", action.onClick);

    actions.appendChild(actionButton);
    content.appendChild(actions);
  }

  card.appendChild(content);
  elements.resultsContainer.appendChild(card);
}

function createExternalLink(label, url) {
  const link = document.createElement("a");

  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;

  return link;
}

function getExternalLinks(match) {
  const links = [];

  if (match.links?.deezer) {
    links.push({
      label: "Abrir na Deezer",
      url: match.links.deezer,
    });
  }

  if (match.links?.spotify) {
    links.push({
      label: "Abrir no Spotify",
      url: match.links.spotify,
    });
  }

  if (match.links?.youtube) {
    links.push({
      label: "Abrir no YouTube",
      url: match.links.youtube,
    });
  }

  return links;
}

function getConfidenceText(confidence) {
  const labels = {
    high: "Alta confiança",
    medium: "Confiança média",
    low: "Baixa confiança",
    none: "Sem confiança",
  };

  return labels[confidence] || "Confiança desconhecida";
}

function createAcrMatchCard(match, isBestGuess = false, confidence = "low") {
  const card = createElement("article", "result-card");

  if (isBestGuess) {
    card.classList.add("result-card--best");
  }

  const content = createElement("div", "result-card__content");

  if (isBestGuess) {
    const badge = createElement(
      "span",
      confidence === "low"
        ? "result-badge result-badge--warning"
        : "result-badge",
      confidence === "low"
        ? "Resultado incerto"
        : "Melhor palpite por cantarolado",
    );

    content.appendChild(badge);
  }

  const title = createElement("h3", "", match.title || "Título desconhecido");
  const artist = createElement("p", "", match.artist || "Artista desconhecido");

  const meta = createElement(
    "span",
    "result-meta",
    `${getConfidenceText(confidence)} • Score: ${Math.round(match.score || 0)}`,
  );

  const source = createElement(
    "span",
    "result-source",
    match.type === "humming"
      ? "Encontrado por humming/cantarolado"
      : "Encontrado por áudio",
  );

  const actions = createElement("div", "result-actions");
  const externalLinks = getExternalLinks(match);

  if (externalLinks.length > 0) {
    externalLinks.forEach((item) => {
      actions.appendChild(createExternalLink(item.label, item.url));
    });
  } else {
    actions.appendChild(
      createElement("span", "no-preview", "Sem link externo"),
    );
  }

  content.append(title, artist, meta, source, actions);
  card.appendChild(content);

  return card;
}

function createTextMusicCard(music, isBestGuess = false) {
  const card = createElement("article", "result-card result-card--with-cover");

  if (isBestGuess) {
    card.classList.add("result-card--best");
  }

  const cover = document.createElement("img");
  cover.className = "result-cover";
  cover.src = music.album?.cover_medium || "https://via.placeholder.com/100";
  cover.alt = `Capa da música ${music.title}`;

  const content = createElement("div", "result-card__content");

  if (isBestGuess) {
    const badge = createElement(
      "span",
      "result-badge",
      "Melhor palpite por fala",
    );
    content.appendChild(badge);
  }

  const title = createElement("h3", "", music.title || "Título desconhecido");
  const artist = createElement(
    "p",
    "",
    music.artist?.name || "Artista desconhecido",
  );

  const meta = createElement(
    "span",
    "result-meta",
    `Compatibilidade: ${Math.min(music.similarity || 0, 99)}%`,
  );

  const actions = createElement("div", "result-actions");

  if (music.preview) {
    actions.appendChild(createPreviewPlayer(music.preview));
  }

  if (music.link) {
    actions.appendChild(createExternalLink("Abrir na Deezer", music.link));
  }

  content.append(title, artist, meta, actions);
  card.append(cover, content);

  return card;
}

function renderAcrResults(matches, confidence) {
  clearResults();

  const isConfident = confidence === "high" || confidence === "medium";

  const title = createElement(
    "h2",
    "result-section-title",
    isConfident
      ? "🎯 Resultado por cantarolado"
      : "⚠️ Possibilidades encontradas, mas sem certeza",
  );

  elements.resultsContainer.appendChild(title);

  matches.slice(0, 6).forEach((match, index) => {
    elements.resultsContainer.appendChild(
      createAcrMatchCard(match, index === 0, confidence),
    );
  });
}

function renderTextResults(results, query) {
  clearResults();

  const title = createElement(
    "h2",
    "result-section-title",
    `🔎 Entendi algo parecido com: "${query}"`,
  );

  elements.resultsContainer.appendChild(title);

  if (!results.length) {
    renderInfoCard(
      "Não encontramos resultados por fala",
      "A gravação foi entendida, mas não encontramos músicas parecidas.",
    );
    return;
  }

  results.slice(0, 8).forEach((music, index) => {
    elements.resultsContainer.appendChild(
      createTextMusicCard(music, index === 0),
    );
  });
}

async function renderRecognitionResult(data) {
  const mode = data.mode || state.mode;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const confidence = data.confidence || "none";
  const speechQuery = data.speech?.query || "";

  if (mode === "speech") {
    if (!speechQuery) {
      setStatus("Não consegui entender sua fala com segurança.");

      renderInfoCard(
        "Não entendi o que foi falado",
        "Tente falar o nome da música ou artista mais perto do microfone.",
      );

      return;
    }

    setStatus(`Entendi: "${speechQuery}". Buscando músicas parecidas...`);

    const textResults = await searchByText(speechQuery);

    setStatus(`Busca concluída para: "${speechQuery}".`);
    renderTextResults(textResults, speechQuery);

    return;
  }

  if (confidence === "high" || confidence === "medium") {
    setStatus("Encontramos possíveis músicas pela melodia.");
    renderAcrResults(matches, confidence);
    return;
  }

  if (matches.length > 0) {
    setStatus(
      "Encontramos possibilidades, mas a confiança ficou baixa. Pode estar errado.",
    );

    renderAcrResults(matches, confidence);
    return;
  }

  setStatus("Não conseguimos reconhecer o cantarolado com segurança.");

  renderInfoCard(
    "Não reconhecemos a melodia",
    "Tente cantarolar o refrão por 15 segundos, sem falar palavras. Se você sabe o nome ou artista, use o modo Falar.",
    {
      label: "Usar modo Falar",
      onClick: () => changeMode("speech"),
    },
  );
}

/* =========================
   Análise com backend
========================= */

async function analyzeRecording() {
  const config = getModeConfig();

  if (!state.audioBlob) {
    setStatus("Grave um áudio antes de analisar.");
    return;
  }

  if (state.recordedDurationSeconds < config.minSeconds) {
    setStatus(
      `A gravação precisa ter pelo menos ${config.minSeconds} segundos.`,
    );
    return;
  }

  try {
    setAnalyzingUI(true);
    clearResults();
    setStatus(config.analyzingStatus);

    const audioBase64 = await blobToBase64(state.audioBlob);

    const response = await fetch("/.netlify/functions/recognize-audio", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: state.mode,
        audioBase64,
        mimeType: state.audioBlob.type || "audio/webm",
      }),
    });

    const data = await readResponseJson(response);

    if (!response.ok || !data.success) {
      const message =
        data.userMessage ||
        data.error ||
        "Não foi possível reconhecer o áudio.";

      throw new Error(getFriendlyBackendError(message));
    }

    await renderRecognitionResult(data);

    console.log("Resultado do reconhecimento:", data);
  } catch (error) {
    console.log(error);

    const friendlyMessage = getFriendlyBackendError(error.message);

    setStatus(friendlyMessage);

    renderInfoCard("Não foi possível analisar agora", friendlyMessage);
  } finally {
    setAnalyzingUI(false);
  }
}

/* =========================
   Eventos
========================= */

elements.modeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    changeMode(input.value);
  });
});

elements.startButton.addEventListener("click", startRecording);
elements.stopButton.addEventListener("click", () => stopRecording());
elements.resetButton.addEventListener("click", resetRecording);
elements.analyzeButton.addEventListener("click", analyzeRecording);

window.addEventListener("beforeunload", () => {
  stopTimer();
  stopMicrophoneTracks();
  clearAudioUrl();
});

updateModeUI();
