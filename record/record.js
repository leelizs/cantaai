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
};

const MIN_RECORDING_SECONDS = 8;
const MAX_RECORDING_SECONDS = 15;

const state = {
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

  const elapsedSeconds = Math.min(getElapsedSeconds(), MAX_RECORDING_SECONDS);
  elements.recordTimer.textContent = formatTime(elapsedSeconds);
}

function startTimer() {
  state.startedAt = Date.now();
  state.recordedDurationSeconds = 0;

  updateTimer();

  state.timerInterval = setInterval(() => {
    updateTimer();

    const elapsedSeconds = getElapsedSeconds();
    const remainingSeconds = Math.max(
      MAX_RECORDING_SECONDS - elapsedSeconds,
      0,
    );

    if (elapsedSeconds < MIN_RECORDING_SECONDS) {
      setStatus(
        `Gravando... continue por pelo menos ${MIN_RECORDING_SECONDS} segundos.`,
      );
      return;
    }

    if (elapsedSeconds < MAX_RECORDING_SECONDS) {
      setStatus(
        `Gravando... você pode parar agora. Tempo restante: ${remainingSeconds}s.`,
      );
    }
  }, 500);
}

function stopTimer() {
  if (state.startedAt) {
    state.recordedDurationSeconds = Math.min(
      getElapsedSeconds(),
      MAX_RECORDING_SECONDS,
    );
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
    }, MAX_RECORDING_SECONDS * 1000);

    setStatus(
      `Gravando... grave entre ${MIN_RECORDING_SECONDS} e ${MAX_RECORDING_SECONDS} segundos.`,
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

  if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
    return;
  }

  const elapsedSeconds = getElapsedSeconds();

  if (!force && elapsedSeconds < MIN_RECORDING_SECONDS) {
    const remainingSeconds = MIN_RECORDING_SECONDS - elapsedSeconds;

    setStatus(
      `Grave pelo menos ${MIN_RECORDING_SECONDS} segundos. Faltam ${remainingSeconds}s.`,
    );

    return;
  }

  stopTimer();

  state.mediaRecorder.stop();
  setRecordingUI(false);

  if (reason === "max-time") {
    setStatus(
      `Gravação finalizada automaticamente em ${MAX_RECORDING_SECONDS} segundos. Você pode ouvir antes de analisar.`,
    );
    return;
  }

  setStatus("Gravação finalizada. Você pode ouvir antes de analisar.");
}

function handleDataAvailable(event) {
  if (event.data && event.data.size > 0) {
    state.audioChunks.push(event.data);
  }
}

function handleRecordingStop() {
  const mimeType = state.mediaRecorder?.mimeType || "audio/webm";

  if (state.recordedDurationSeconds < MIN_RECORDING_SECONDS) {
    resetAudioState();
    stopMicrophoneTracks();
    setRecordingUI(false);

    setStatus(
      `A gravação ficou curta demais. Grave pelo menos ${MIN_RECORDING_SECONDS} segundos.`,
    );

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

function renderInfoCard(title, description) {
  clearResults();

  const card = createElement("article", "result-card result-card--info");
  const content = createElement("div", "result-card__content");

  const cardTitle = createElement("h3", "", title);
  const cardDescription = createElement("p", "", description);

  content.append(cardTitle, cardDescription);
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
      "result-badge",
      "Melhor palpite por áudio",
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
      ? "Encontrado por cantarolado/humming"
      : "Encontrado por reconhecimento de áudio",
  );

  const actions = createElement("div", "result-actions");

  const externalLinks = getExternalLinks(match);

  if (externalLinks.length > 0) {
    externalLinks.forEach((item) => {
      actions.appendChild(createExternalLink(item.label, item.url));
    });
  } else {
    const noLinks = createElement("span", "no-preview", "Sem link externo");
    actions.appendChild(noLinks);
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
      "Melhor palpite por texto",
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

  if (!matches.length) {
    renderInfoCard(
      "Não reconhecemos essa gravação",
      "Tente gravar de novo com menos barulho, mais perto do microfone ou usando um trecho mais conhecido.",
    );
    return;
  }

  const title = createElement(
    "h2",
    "result-section-title",
    confidence === "high"
      ? "🎯 Melhor palpite por áudio"
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
    `🔎 Busca interpretada: "${query}"`,
  );

  elements.resultsContainer.appendChild(title);

  if (!results.length) {
    renderInfoCard(
      "Não encontramos resultados por texto",
      "A gravação não ficou clara o suficiente para reconhecer ou interpretar.",
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
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const confidence = data.confidence || "none";
  const speechQuery = data.speech?.query || "";

  if (confidence === "high") {
    setStatus("Reconhecemos uma música com boa confiança.");
    renderAcrResults(matches, confidence);
    return;
  }

  if (speechQuery) {
    setStatus(
      `O reconhecimento por áudio ficou incerto. Tentando como busca por texto: "${speechQuery}".`,
    );

    renderInfoCard(
      "Tentando interpretar sua gravação como texto",
      `O CantaAI entendeu algo parecido com: "${speechQuery}".`,
    );

    const textResults = await searchByText(speechQuery);

    setStatus(`Busca por texto concluída para: "${speechQuery}".`);
    renderTextResults(textResults, speechQuery);
    return;
  }

  if (matches.length > 0) {
    setStatus(
      "Encontramos algumas possibilidades, mas com baixa confiança. O resultado pode estar errado.",
    );
    renderAcrResults(matches, confidence);
    return;
  }

  setStatus(
    "Não conseguimos reconhecer essa gravação com segurança. Tente novamente.",
  );

  renderInfoCard(
    "Não reconhecemos com segurança",
    "Tente gravar a música tocando no ambiente ou cantarolar um trecho mais marcante.",
  );
}

/* =========================
   Análise com backend
========================= */

async function analyzeRecording() {
  if (!state.audioBlob) {
    setStatus("Grave um áudio antes de analisar.");
    return;
  }

  if (state.recordedDurationSeconds < MIN_RECORDING_SECONDS) {
    setStatus(
      `A gravação precisa ter pelo menos ${MIN_RECORDING_SECONDS} segundos.`,
    );
    return;
  }

  try {
    setAnalyzingUI(true);
    clearResults();
    setStatus("Enviando áudio para reconhecimento...");

    const audioBase64 = await blobToBase64(state.audioBlob);

    const response = await fetch("/.netlify/functions/recognize-audio", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audioBase64,
        mimeType: state.audioBlob.type || "audio/webm",
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Não foi possível reconhecer o áudio.");
    }

    await renderRecognitionResult(data);

    console.log("Resultado do reconhecimento:", data);
  } catch (error) {
    console.log(error);

    setStatus(error.message || "Erro ao analisar gravação.");

    renderInfoCard(
      "Algo deu errado",
      "Não conseguimos analisar essa gravação agora. Tente novamente em alguns segundos.",
    );
  } finally {
    setAnalyzingUI(false);
  }
}

/* =========================
   Eventos
========================= */

elements.startButton.addEventListener("click", startRecording);
elements.stopButton.addEventListener("click", () => stopRecording());
elements.resetButton.addEventListener("click", resetRecording);
elements.analyzeButton.addEventListener("click", analyzeRecording);

window.addEventListener("beforeunload", () => {
  stopTimer();
  stopMicrophoneTracks();
  clearAudioUrl();
});
