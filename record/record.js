(() => {
  "use strict";

  const SPEECH_RECOGNITION_LANGUAGE = "en-US";
  const MAX_QUERY_LENGTH = 180;
  const TEXT_SEARCH_TIMEOUT_MS = 22000;
  const HUMMING_SEARCH_TIMEOUT_MS = 45000;

  const ENDPOINTS = {
    searchMusic: "/.netlify/functions/search-music",
    recognizeAudio: "/.netlify/functions/recognize-audio",
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

  const RECORDING_MODES = {
    speech: {
      label: "Falar o que lembra",
      minSeconds: 1,
      maxSeconds: 8,
      hint: 'Fale algo como "bad michael jackson", "smooth criminal" ou um trecho da letra.',
      startButtonText: "Começar a ouvir",
      stopButtonText: "Parar",
      resetButtonText: "Limpar",
      analyzeButtonText: "Buscar música",
      startStatus: "Ouvindo... fale o nome, artista ou trecho que você lembra.",
      readyStatus: "Ouvindo... você já pode parar quando terminar de falar.",
      finishedStatus: "Pronto. Confira o texto entendido e busque a música.",
      autoFinishedStatus:
        "Parei de ouvir automaticamente. Confira o texto antes de buscar.",
      shortStatus: "Fale por pelo menos 1 segundo para analisarmos melhor.",
      analyzingStatus: "Buscando músicas parecidas...",
      tips: {
        oneTitle: "Fale de forma simples",
        oneText:
          "Diga o nome da música, artista ou um pedaço da letra. Não precisa cantar perfeito.",
        twoTitle: "Corrija se precisar",
        twoText: "Se o CantaAI entender errado, edite o texto antes de buscar.",
        threeTitle: "IA só se você pedir",
        threeText:
          "Primeiro o CantaAI busca sem gastar IA. Depois você pode refinar se precisar.",
      },
    },

    humming: {
      label: "Cantarolar melodia",
      minSeconds: 10,
      maxSeconds: 15,
      hint: "Cantarole o refrão com “hmmm” ou “nanana”. Não fale o nome da música neste modo.",
      startButtonText: "Começar gravação",
      stopButtonText: "Parar",
      resetButtonText: "Regravar",
      analyzeButtonText: "Analisar gravação",
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

  const app = {
    elements: null,
    state: {
      mode: "speech",
      mediaStream: null,
      mediaRecorder: null,
      speechRecognition: null,
      speechFinalText: "",
      speechInterimText: "",
      lastSpeechError: null,
      audioChunks: [],
      audioBlob: null,
      audioUrl: null,
      timerInterval: null,
      maxRecordTimeout: null,
      startedAt: null,
      recordedDurationSeconds: 0,
      isCapturing: false,
      isAnalyzing: false,
      stopReason: "manual",
    },
  };

  /* =========================
     DOM
  ========================= */

  function getElements() {
    const byId = (id) => document.getElementById(id);

    const elements = {
      page: document.querySelector(".record-page"),
      startButton: byId("startRecordButton"),
      stopButton: byId("stopRecordButton"),
      resetButton: byId("resetRecordButton"),
      analyzeButton: byId("analyzeButton"),
      audioPreview: byId("audioPreview"),
      statusText: byId("status"),
      recordTimer: byId("recordTimer"),
      recorderVisual: byId("recorderVisual"),
      resultsContainer: byId("recordResults"),
      modeHint: byId("modeHint"),
      speechPanel: byId("speechPanel"),
      speechTranscript: byId("speechTranscript"),
      modeInputs: document.querySelectorAll('input[name="recordMode"]'),
      modeCards: document.querySelectorAll(".mode-card"),
      tipOneTitle: byId("tipOneTitle"),
      tipOneText: byId("tipOneText"),
      tipTwoTitle: byId("tipTwoTitle"),
      tipTwoText: byId("tipTwoText"),
      tipThreeTitle: byId("tipThreeTitle"),
      tipThreeText: byId("tipThreeText"),
    };

    const missingElements = Object.entries(elements).filter(([, value]) => {
      if (value instanceof NodeList) {
        return value.length === 0;
      }

      return !value;
    });

    if (missingElements.length > 0) {
      console.error(
        "CantaAI Record: elementos obrigatórios não encontrados:",
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

    const checkedMode = Array.from(elements.modeInputs).find(
      (input) => input.checked,
    )?.value;

    if (RECORDING_MODES[checkedMode]) {
      app.state.mode = checkedMode;
    }

    bindEvents();
    updateModeUI();
    elements.page.classList.add("is-ready");
  }

  /* =========================
     Helpers
  ========================= */

  function getModeConfig() {
    return RECORDING_MODES[app.state.mode];
  }

  function isSpeechMode() {
    return app.state.mode === "speech";
  }

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

  function formatTime(totalSeconds) {
    const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
    const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, "0");
    const seconds = String(Math.floor(safeSeconds % 60)).padStart(2, "0");

    return `${minutes}:${seconds}`;
  }

  function getElapsedSeconds() {
    if (!app.state.startedAt) {
      return 0;
    }

    return Math.floor((Date.now() - app.state.startedAt) / 1000);
  }

  function updateTimer() {
    const { recordTimer } = app.elements;

    if (!app.state.startedAt) {
      recordTimer.textContent = "00:00";
      return;
    }

    const { maxSeconds } = getModeConfig();
    const elapsedSeconds = Math.min(getElapsedSeconds(), maxSeconds);

    recordTimer.textContent = formatTime(elapsedSeconds);
  }

  function startTimer() {
    const state = app.state;

    stopTimer({ keepDuration: false });

    state.startedAt = Date.now();
    state.recordedDurationSeconds = 0;

    updateTimer();

    state.timerInterval = window.setInterval(() => {
      const { minSeconds, maxSeconds, readyStatus } = getModeConfig();
      const elapsedSeconds = getElapsedSeconds();
      const remainingSeconds = Math.max(maxSeconds - elapsedSeconds, 0);
      const actionLabel = isSpeechMode() ? "Ouvindo" : "Gravando";

      updateTimer();

      if (elapsedSeconds < minSeconds) {
        setStatus(
          `${actionLabel}... continue por pelo menos ${minSeconds} segundo(s).`,
        );
        return;
      }

      if (elapsedSeconds < maxSeconds) {
        setStatus(`${readyStatus} Tempo restante: ${remainingSeconds}s.`);
      }
    }, 500);
  }

  function stopTimer(options = {}) {
    const { keepDuration = true } = options;
    const state = app.state;

    if (keepDuration && state.startedAt) {
      const { maxSeconds } = getModeConfig();
      state.recordedDurationSeconds = Math.min(getElapsedSeconds(), maxSeconds);
    }

    window.clearInterval(state.timerInterval);
    window.clearTimeout(state.maxRecordTimeout);

    state.timerInterval = null;
    state.maxRecordTimeout = null;
    state.startedAt = null;
  }

  function hasSpeechText() {
    return normalizeText(app.elements.speechTranscript.value).length >= 2;
  }

  function hasAudioReady() {
    return Boolean(app.state.audioBlob);
  }

  function hasAnalyzableContent() {
    return isSpeechMode() ? hasSpeechText() : hasAudioReady();
  }

  function updateButtons() {
    const { elements, state } = app;
    const config = getModeConfig();
    const canReset = isSpeechMode()
      ? normalizeText(elements.speechTranscript.value).length > 0
      : hasAudioReady();

    elements.startButton.textContent = config.startButtonText;
    elements.stopButton.textContent = config.stopButtonText;
    elements.resetButton.textContent = config.resetButtonText;
    elements.analyzeButton.textContent = state.isAnalyzing
      ? "Analisando..."
      : config.analyzeButtonText;

    elements.startButton.disabled = state.isCapturing || state.isAnalyzing;
    elements.stopButton.disabled = !state.isCapturing || state.isAnalyzing;
    elements.resetButton.disabled =
      state.isCapturing || state.isAnalyzing || !canReset;
    elements.analyzeButton.disabled =
      state.isCapturing || state.isAnalyzing || !hasAnalyzableContent();

    elements.analyzeButton.classList.toggle("is-loading", state.isAnalyzing);
    elements.analyzeButton.setAttribute("aria-busy", String(state.isAnalyzing));

    elements.modeInputs.forEach((input) => {
      input.disabled = state.isCapturing || state.isAnalyzing;
    });

    elements.modeCards.forEach((card) => {
      const input = card.querySelector('input[name="recordMode"]');
      const isDisabled = Boolean(input?.disabled);

      card.classList.toggle("is-disabled", isDisabled);
    });

    elements.speechTranscript.disabled =
      state.isAnalyzing || state.isCapturing || !isSpeechMode();
  }

  function setCapturingUI(isCapturing) {
    app.state.isCapturing = isCapturing;

    app.elements.recorderVisual.classList.toggle("is-recording", isCapturing);
    app.elements.recorderVisual.setAttribute(
      "aria-label",
      isCapturing ? "Microfone ativo" : "Microfone parado",
    );

    updateButtons();
  }

  function setAnalyzingUI(isAnalyzing) {
    app.state.isAnalyzing = isAnalyzing;
    updateButtons();
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

  function clearAudioUrl() {
    if (app.state.audioUrl) {
      URL.revokeObjectURL(app.state.audioUrl);
    }

    app.state.audioUrl = null;
  }

  function resetAudioState() {
    const { state, elements } = app;

    clearAudioUrl();

    state.audioChunks = [];
    state.audioBlob = null;
    state.recordedDurationSeconds = 0;

    elements.audioPreview.pause();
    elements.audioPreview.removeAttribute("src");
    elements.audioPreview.load();
    elements.audioPreview.hidden = true;
    elements.recordTimer.textContent = "00:00";
  }

  function resetSpeechState() {
    app.state.speechFinalText = "";
    app.state.speechInterimText = "";
    app.state.lastSpeechError = null;
    app.elements.speechTranscript.value = "";
  }

  function clearResults() {
    pauseAllPreviewAudios();
    app.elements.resultsContainer.replaceChildren();
  }

  function resetCurrentModeState(options = {}) {
    const { updateStatus = true } = options;

    stopTimer();
    cleanupSpeechRecognition({ abort: true });
    cleanupMediaRecorder({ stop: true });
    stopMicrophoneTracks();
    clearResults();
    resetAudioState();
    resetSpeechState();
    setCapturingUI(false);

    if (updateStatus) {
      setStatus("Clique em começar.");
    }

    updateButtons();
  }

  function isSafeHttpUrl(url) {
    try {
      const parsedUrl = new URL(url, window.location.origin);
      return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function getFriendlyMicrophoneError(error) {
    const name = error?.name || "";
    const message = String(error?.message || "").toLowerCase();

    if (message.includes("mediarecorder") || message.includes("gravação")) {
      return "Este navegador não suporta gravação de áudio pelo CantaAI. Tente pelo Chrome ou Edge atualizado.";
    }

    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "Nenhum microfone foi encontrado. Conecte um fone com microfone ou teste pelo celular.";
    }

    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Permissão negada. Libere o microfone para o CantaAI gravar.";
    }

    if (name === "NotReadableError") {
      return "O microfone está sendo usado por outro aplicativo ou não pôde ser acessado.";
    }

    if (name === "SecurityError") {
      return "O CantaAI precisa estar em HTTPS para acessar o microfone com segurança.";
    }

    return "Não foi possível acessar o microfone. Verifique as permissões e tente novamente.";
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
      return "A análise demorou demais. Tente novamente com uma gravação mais clara.";
    }

    if (text.includes("failed to fetch") || text.includes("network")) {
      return "Não conseguimos conectar ao servidor do CantaAI. Verifique sua internet e tente novamente.";
    }

    return (
      message ||
      "Não conseguimos analisar agora. Tente novamente em alguns segundos."
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

  async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    if (!navigator.onLine) {
      throw new Error("Você está sem conexão.");
    }

    if (!window.AbortController) {
      return fetch(url, options);
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
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

  function clampNumber(value, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return min;
    }

    return Math.min(Math.max(number, min), max);
  }

  /* =========================
     Modo de busca
  ========================= */

  function updateModeUI() {
    const { elements, state } = app;
    const config = getModeConfig();

    elements.modeInputs.forEach((input) => {
      input.checked = input.value === state.mode;
    });

    elements.modeCards.forEach((card) => {
      const input = card.querySelector('input[name="recordMode"]');
      const isSelected = input?.value === state.mode;

      card.classList.toggle("is-selected", isSelected);
    });

    elements.modeHint.textContent = config.hint;
    elements.speechPanel.hidden = !isSpeechMode();
    elements.audioPreview.hidden = isSpeechMode() || !state.audioBlob;

    elements.tipOneTitle.textContent = config.tips.oneTitle;
    elements.tipOneText.textContent = config.tips.oneText;
    elements.tipTwoTitle.textContent = config.tips.twoTitle;
    elements.tipTwoText.textContent = config.tips.twoText;
    elements.tipThreeTitle.textContent = config.tips.threeTitle;
    elements.tipThreeText.textContent = config.tips.threeText;

    elements.recordTimer.textContent = "00:00";

    setStatus("Clique em começar.");
    updateButtons();
  }

  function changeMode(mode) {
    if (!RECORDING_MODES[mode]) {
      return;
    }

    if (app.state.isCapturing || app.state.isAnalyzing) {
      return;
    }

    if (app.state.mode === mode) {
      updateModeUI();
      return;
    }

    app.state.mode = mode;
    resetCurrentModeState({ updateStatus: false });
    updateModeUI();
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
     Speech Recognition
  ========================= */

  function getSpeechRecognitionConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isSpeechRecognitionSupported() {
    return Boolean(getSpeechRecognitionConstructor());
  }

  function createSpeechRecognition() {
    const SpeechRecognitionConstructor = getSpeechRecognitionConstructor();

    if (!SpeechRecognitionConstructor) {
      return null;
    }

    const recognition = new SpeechRecognitionConstructor();

    recognition.lang = SPEECH_RECOGNITION_LANGUAGE;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    return recognition;
  }

  function addSpeechRecognitionListeners(recognition) {
    recognition.addEventListener("result", handleSpeechResult);
    recognition.addEventListener("error", handleSpeechError);
    recognition.addEventListener("end", handleSpeechEnd);
  }

  function removeSpeechRecognitionListeners(recognition) {
    recognition.removeEventListener("result", handleSpeechResult);
    recognition.removeEventListener("error", handleSpeechError);
    recognition.removeEventListener("end", handleSpeechEnd);
  }

  function cleanupSpeechRecognition(options = {}) {
    const { abort = false } = options;
    const recognition = app.state.speechRecognition;

    if (!recognition) {
      return;
    }

    removeSpeechRecognitionListeners(recognition);

    if (abort) {
      try {
        recognition.abort();
      } catch (error) {
        console.log("Speech abort ignorado:", error);
      }
    }

    app.state.speechRecognition = null;
  }

  function updateSpeechTranscriptText() {
    const text = normalizeText(
      `${app.state.speechFinalText} ${app.state.speechInterimText}`,
    );

    app.elements.speechTranscript.value = text;
    updateButtons();
  }

  function startSpeechCapture() {
    const config = getModeConfig();

    clearResults();
    resetSpeechState();
    resetAudioState();

    if (!isSpeechRecognitionSupported()) {
      setStatus(
        "Este navegador não suporta reconhecimento de fala. Digite o que você lembra no campo acima.",
        "warning",
      );

      app.elements.speechTranscript.disabled = false;
      app.elements.speechTranscript.focus();
      updateButtons();
      return;
    }

    const recognition = createSpeechRecognition();

    if (!recognition) {
      setStatus(
        "Não foi possível iniciar o reconhecimento. Digite o que você lembra no campo acima.",
        "warning",
      );
      return;
    }

    app.state.speechRecognition = recognition;
    app.state.stopReason = "manual";
    app.state.lastSpeechError = null;

    addSpeechRecognitionListeners(recognition);

    try {
      recognition.start();

      startTimer();
      setCapturingUI(true);

      app.state.maxRecordTimeout = window.setTimeout(() => {
        stopSpeechCapture("max-time");
      }, config.maxSeconds * 1000);

      setStatus(`${config.startStatus} Tempo máximo: ${config.maxSeconds}s.`);
    } catch (error) {
      console.log("Erro ao iniciar fala:", error);

      cleanupSpeechRecognition();
      stopTimer();
      setCapturingUI(false);
      setStatus(
        "Não foi possível iniciar o reconhecimento de fala. Tente digitar o que você lembra.",
        "error",
      );
    }
  }

  function stopSpeechCapture(reason = "manual") {
    const recognition = app.state.speechRecognition;

    if (!recognition) {
      return;
    }

    app.state.stopReason = reason;
    stopTimer();

    try {
      recognition.stop();
    } catch (error) {
      console.log("Speech stop ignorado:", error);
      handleSpeechEnd();
    }
  }

  function handleSpeechResult(event) {
    let finalText = "";
    let interimText = "";

    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
      const result = event.results[index];
      const transcript = result[0]?.transcript || "";

      if (result.isFinal) {
        finalText += ` ${transcript}`;
      } else {
        interimText += ` ${transcript}`;
      }
    }

    if (finalText.trim()) {
      app.state.speechFinalText = normalizeText(
        `${app.state.speechFinalText} ${finalText}`,
      );
    }

    app.state.speechInterimText = normalizeText(interimText);

    updateSpeechTranscriptText();

    if (hasSpeechText()) {
      setStatus(
        "Entendi algo. Você pode parar, corrigir o texto ou buscar direto.",
        "success",
      );
    }
  }

  function handleSpeechError(event) {
    console.log("Erro SpeechRecognition:", event.error);

    const messages = {
      "no-speech":
        "Não ouvi nenhuma fala. Tente falar mais perto do microfone.",
      "audio-capture": "Não consegui acessar o microfone.",
      "not-allowed":
        "Permissão negada. Libere o microfone para o CantaAI ouvir.",
      network: "Falha de rede no reconhecimento de fala. Tente novamente.",
      aborted: "Reconhecimento interrompido.",
    };

    app.state.lastSpeechError =
      messages[event.error] ||
      "Não consegui entender a fala. Você pode digitar o que lembra.";

    if (event.error !== "aborted") {
      setStatus(app.state.lastSpeechError, "warning");
    }
  }

  function handleSpeechEnd() {
    const config = getModeConfig();
    const recognition = app.state.speechRecognition;

    if (recognition) {
      removeSpeechRecognitionListeners(recognition);
      app.state.speechRecognition = null;
    }

    stopTimer();
    setCapturingUI(false);

    app.state.speechInterimText = "";
    updateSpeechTranscriptText();

    if (hasSpeechText()) {
      setStatus(
        app.state.stopReason === "max-time"
          ? config.autoFinishedStatus
          : config.finishedStatus,
        "success",
      );
      return;
    }

    setStatus(
      app.state.lastSpeechError ||
        "Não entendi nenhuma fala. Tente novamente ou digite o que lembra.",
      "warning",
    );
  }

  /* =========================
     Microfone / áudio
  ========================= */

  async function requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Seu navegador não suporta gravação de áudio.");
    }

    if (!window.MediaRecorder) {
      throw new Error("MediaRecorder indisponível para gravação de áudio.");
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  }

  function getSupportedMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return "";
    }

    const mimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
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

  function addMediaRecorderListeners(recorder) {
    recorder.addEventListener("dataavailable", handleDataAvailable);
    recorder.addEventListener("stop", handleRecordingStop);
    recorder.addEventListener("error", handleRecordingError);
  }

  function removeMediaRecorderListeners(recorder) {
    recorder.removeEventListener("dataavailable", handleDataAvailable);
    recorder.removeEventListener("stop", handleRecordingStop);
    recorder.removeEventListener("error", handleRecordingError);
  }

  function cleanupMediaRecorder(options = {}) {
    const { stop = false } = options;
    const recorder = app.state.mediaRecorder;

    if (!recorder) {
      return;
    }

    if (stop && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch (error) {
        console.log("MediaRecorder stop ignorado:", error);
      }
    }

    removeMediaRecorderListeners(recorder);
    app.state.mediaRecorder = null;
  }

  function stopMicrophoneTracks() {
    const stream = app.state.mediaStream;

    if (!stream) {
      return;
    }

    stream.getTracks().forEach((track) => track.stop());
    app.state.mediaStream = null;
  }

  /* =========================
     Humming Recorder
  ========================= */

  async function startHummingRecording() {
    const config = getModeConfig();

    try {
      clearResults();
      resetAudioState();
      resetSpeechState();
      cleanupMediaRecorder();
      stopMicrophoneTracks();

      app.state.mediaStream = await requestMicrophone();
      app.state.mediaRecorder = createMediaRecorder(app.state.mediaStream);
      app.state.audioChunks = [];
      app.state.stopReason = "manual";

      addMediaRecorderListeners(app.state.mediaRecorder);
      app.state.mediaRecorder.start(250);

      startTimer();
      setCapturingUI(true);

      app.state.maxRecordTimeout = window.setTimeout(
        () => {
          stopHummingRecording({
            force: true,
            reason: "max-time",
          });
        },
        config.maxSeconds * 1000 + 150,
      );

      setStatus(
        `${config.startStatus} Grave entre ${config.minSeconds} e ${config.maxSeconds} segundos.`,
      );
    } catch (error) {
      console.log(error);

      cleanupMediaRecorder();
      stopTimer();
      stopMicrophoneTracks();
      setCapturingUI(false);
      setStatus(getFriendlyMicrophoneError(error), "error");
    }
  }

  function stopHummingRecording(options = {}) {
    const { force = false, reason = "manual" } = options;
    const recorder = app.state.mediaRecorder;
    const config = getModeConfig();

    if (!recorder || recorder.state !== "recording") {
      return;
    }

    const elapsedSeconds = getElapsedSeconds();

    if (!force && elapsedSeconds < config.minSeconds) {
      const remainingSeconds = Math.max(config.minSeconds - elapsedSeconds, 1);

      setStatus(
        `${config.shortStatus} Faltam ${remainingSeconds}s.`,
        "warning",
      );
      return;
    }

    app.state.stopReason = reason;

    try {
      recorder.requestData();
    } catch (error) {
      console.log("requestData ignorado:", error);
    }

    stopTimer();

    try {
      recorder.stop();
    } catch (error) {
      console.log("Erro ao parar gravação:", error);
      handleRecordingError(error);
      return;
    }

    setCapturingUI(false);

    setStatus(
      reason === "max-time" ? config.autoFinishedStatus : config.finishedStatus,
      reason === "max-time" ? "success" : "info",
    );
  }

  function handleDataAvailable(event) {
    if (event.data && event.data.size > 0) {
      app.state.audioChunks.push(event.data);
    }
  }

  function handleRecordingError(error) {
    console.log("Erro MediaRecorder:", error);

    cleanupMediaRecorder();
    stopTimer();
    stopMicrophoneTracks();
    resetAudioState();
    setCapturingUI(false);
    setStatus("Ocorreu um erro durante a gravação. Tente novamente.", "error");
  }

  function handleRecordingStop() {
    const { state, elements } = app;
    const config = getModeConfig();
    const recorder = state.mediaRecorder;
    const mimeType =
      recorder?.mimeType || state.audioChunks[0]?.type || "audio/webm";

    if (recorder) {
      removeMediaRecorderListeners(recorder);
      state.mediaRecorder = null;
    }

    stopMicrophoneTracks();

    if (state.recordedDurationSeconds < config.minSeconds) {
      resetAudioState();
      setCapturingUI(false);
      setStatus(config.shortStatus, "warning");
      return;
    }

    if (!state.audioChunks.length) {
      resetAudioState();
      setCapturingUI(false);
      setStatus(
        "Não recebemos áudio do microfone. Tente gravar novamente.",
        "warning",
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

    setCapturingUI(false);
    updateButtons();
  }

  /* =========================
     Ações principais
  ========================= */

  function startCapture() {
    if (app.state.isCapturing || app.state.isAnalyzing) {
      return;
    }

    if (isSpeechMode()) {
      startSpeechCapture();
      return;
    }

    startHummingRecording();
  }

  function stopCapture() {
    if (!app.state.isCapturing || app.state.isAnalyzing) {
      return;
    }

    if (isSpeechMode()) {
      stopSpeechCapture("manual");
      return;
    }

    stopHummingRecording();
  }

  async function resetCapture() {
    if (app.state.isCapturing || app.state.isAnalyzing) {
      return;
    }

    if (isSpeechMode()) {
      resetSpeechState();
      clearResults();
      app.elements.recordTimer.textContent = "00:00";
      setStatus("Campo limpo. Fale novamente ou digite o que lembra.");
      updateButtons();
      app.elements.speechTranscript.focus();
      return;
    }

    resetAudioState();
    setCapturingUI(false);
    setStatus("Preparando nova gravação...");

    await startHummingRecording();
  }

  /* =========================
     Busca textual
  ========================= */

  async function searchByText(query, options = {}) {
    const { useAi = false } = options;
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
      },
      TEXT_SEARCH_TIMEOUT_MS,
    );

    const data = await readResponseJson(response);

    if (!response.ok) {
      throw new Error(
        data.userMessage || data.error || "Erro ao buscar músicas por texto.",
      );
    }

    return Array.isArray(data.results) ? data.results : [];
  }

  /* =========================
     Renderização dos resultados
  ========================= */

  function renderInfoCard(title, description, action = null) {
    clearResults();

    const card = createInfoCard(title, description, action);
    app.elements.resultsContainer.appendChild(card);
  }

  function createInfoCard(title, description, action = null) {
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

    return card;
  }

  function createExternalLink(label, url) {
    if (!isSafeHttpUrl(url)) {
      return null;
    }

    const link = document.createElement("a");
    const parsedUrl = new URL(url, window.location.origin);

    link.href = parsedUrl.href;
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
    const artist = createElement(
      "p",
      "",
      match.artist || "Artista desconhecido",
    );
    const score = Math.round(clampNumber(match.score, 0, 100));

    const meta = createElement(
      "span",
      "result-meta",
      `${getConfidenceText(confidence)} • Score: ${score}`,
    );

    const source = createElement(
      "span",
      "result-source",
      match.type === "humming"
        ? "Encontrado por humming/cantarolado"
        : "Encontrado por áudio",
    );

    const actions = createElement("div", "result-actions");
    const externalLinks = getExternalLinks(match)
      .map((item) => createExternalLink(item.label, item.url))
      .filter(Boolean);

    if (externalLinks.length > 0) {
      externalLinks.forEach((link) => actions.appendChild(link));
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
    const card = createElement(
      "article",
      "result-card result-card--with-cover",
    );

    if (isBestGuess) {
      card.classList.add("result-card--best");
    }

    const cover = document.createElement("img");
    const musicTitle = music.title || "música encontrada";

    cover.className = "result-cover";
    cover.src =
      music.album?.cover_medium || music.album?.cover || DEFAULT_COVER;
    cover.alt = `Capa da música ${musicTitle}`;
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

    const content = createElement("div", "result-card__content");

    if (isBestGuess) {
      const badge = createElement("span", "result-badge", "Melhor palpite");
      content.appendChild(badge);
    }

    const title = createElement("h3", "", music.title || "Título desconhecido");
    const artist = createElement(
      "p",
      "",
      music.artist?.name || music.artist || "Artista desconhecido",
    );

    const similarity = Math.round(clampNumber(music.similarity, 0, 99));
    const meta = createElement(
      "span",
      "result-meta",
      `Compatibilidade: ${similarity}%`,
    );

    const actions = createElement("div", "result-actions");

    if (music.preview) {
      actions.appendChild(createPreviewPlayer(music.preview));
    }

    const deezerLink = music.link
      ? createExternalLink("Abrir na Deezer", music.link)
      : null;

    if (deezerLink) {
      actions.appendChild(deezerLink);
    }

    if (!actions.children.length) {
      actions.appendChild(
        createElement("span", "no-preview", "Sem prévia disponível"),
      );
    }

    content.append(title, artist, meta, actions);
    card.append(cover, content);

    return card;
  }

  function createAiRefinementCard(query) {
    return createInfoCard(
      "Quer uma busca mais precisa com IA?",
      "A primeira busca não usa IA. Se o resultado não ficou bom, você pode pedir para o CantaAI refinar usando IA.",
      {
        label: "Refinar com IA",
        onClick: () =>
          runSpeechSearch({
            query,
            useAi: true,
          }),
      },
    );
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

    app.elements.resultsContainer.appendChild(title);

    matches.slice(0, 6).forEach((match, index) => {
      app.elements.resultsContainer.appendChild(
        createAcrMatchCard(match, index === 0, confidence),
      );
    });
  }

  function renderTextResults(results, query, options = {}) {
    const { canRefineWithAi = false } = options;

    clearResults();

    const title = createElement(
      "h2",
      "result-section-title",
      `🔎 Busca: "${query}"`,
    );

    app.elements.resultsContainer.appendChild(title);

    if (!results.length) {
      app.elements.resultsContainer.appendChild(
        createInfoCard(
          "Não encontramos resultados",
          "Tente corrigir o texto, buscar com menos palavras ou refinar com IA.",
        ),
      );
    } else {
      results.slice(0, 8).forEach((music, index) => {
        app.elements.resultsContainer.appendChild(
          createTextMusicCard(music, index === 0),
        );
      });
    }

    if (canRefineWithAi) {
      app.elements.resultsContainer.appendChild(createAiRefinementCard(query));
    }
  }

  function renderRecognitionResult(data) {
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const confidence = data.confidence || "none";

    if (confidence === "high" || confidence === "medium") {
      setStatus("Encontramos possíveis músicas pela melodia.", "success");
      renderAcrResults(matches, confidence);
      return;
    }

    if (matches.length > 0) {
      setStatus(
        "Encontramos possibilidades, mas a confiança ficou baixa. Pode estar errado.",
        "warning",
      );

      renderAcrResults(matches, confidence);
      return;
    }

    setStatus(
      "Não conseguimos reconhecer o cantarolado com segurança.",
      "warning",
    );

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
     Análise
  ========================= */

  async function runSpeechSearch({ query, useAi = false }) {
    const searchQuery = normalizeText(query);

    if (searchQuery.length < 2) {
      setStatus("Fale ou digite algo antes de buscar.", "warning");
      return;
    }

    setAnalyzingUI(true);
    clearResults();

    setStatus(
      useAi
        ? `Refinando com IA: "${searchQuery}"...`
        : `Buscando músicas parecidas com: "${searchQuery}"...`,
    );

    try {
      const results = await searchByText(searchQuery, { useAi });

      setStatus(
        useAi
          ? `Busca refinada com IA para: "${searchQuery}".`
          : `Busca concluída sem IA para: "${searchQuery}".`,
        "success",
      );

      renderTextResults(results, searchQuery, {
        canRefineWithAi: !useAi,
      });
    } catch (error) {
      console.log(error);

      const friendlyMessage = getFriendlyBackendError(error.message);

      setStatus(friendlyMessage, "error");
      renderInfoCard("Não foi possível buscar agora", friendlyMessage);
    } finally {
      setAnalyzingUI(false);
    }
  }

  function analyzeSpeech() {
    const query = normalizeText(app.elements.speechTranscript.value);

    app.elements.speechTranscript.value = query;

    runSpeechSearch({
      query,
      useAi: false,
    });
  }

  async function analyzeHumming() {
    const config = getModeConfig();

    if (!app.state.audioBlob) {
      setStatus("Grave um áudio antes de analisar.", "warning");
      return;
    }

    if (app.state.recordedDurationSeconds < config.minSeconds) {
      setStatus(
        `A gravação precisa ter pelo menos ${config.minSeconds} segundos.`,
        "warning",
      );
      return;
    }

    try {
      setAnalyzingUI(true);
      clearResults();
      setStatus(config.analyzingStatus);

      const audioBase64 = await blobToBase64(app.state.audioBlob);

      const response = await fetchWithTimeout(
        ENDPOINTS.recognizeAudio,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            mode: "humming",
            audioBase64,
            mimeType: app.state.audioBlob.type || "audio/webm",
            durationSeconds: app.state.recordedDurationSeconds,
          }),
        },
        HUMMING_SEARCH_TIMEOUT_MS,
      );

      const data = await readResponseJson(response);

      if (!response.ok || !data.success) {
        const message =
          data.userMessage ||
          data.error ||
          "Não foi possível reconhecer o áudio.";

        throw new Error(message);
      }

      renderRecognitionResult(data);
      console.log("Resultado do reconhecimento:", data);
    } catch (error) {
      console.log(error);

      const friendlyMessage = getFriendlyBackendError(error.message);

      setStatus(friendlyMessage, "error");
      renderInfoCard("Não foi possível analisar agora", friendlyMessage);
    } finally {
      setAnalyzingUI(false);
    }
  }

  function analyzeCurrentMode() {
    if (isSpeechMode()) {
      analyzeSpeech();
      return;
    }

    analyzeHumming();
  }

  /* =========================
     Eventos
  ========================= */

  function bindEvents() {
    const { elements } = app;

    elements.modeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          changeMode(input.value);
        }
      });
    });

    elements.modeCards.forEach((card) => {
      card.addEventListener("click", () => {
        const input = card.querySelector('input[name="recordMode"]');

        if (!input || input.disabled || input.checked) {
          return;
        }

        input.checked = true;
        changeMode(input.value);
      });
    });

    elements.speechTranscript.addEventListener("input", () => {
      const transcript = normalizeText(elements.speechTranscript.value);

      app.state.speechFinalText = transcript;
      app.state.speechInterimText = "";
      updateButtons();
    });

    elements.startButton.addEventListener("click", startCapture);
    elements.stopButton.addEventListener("click", stopCapture);
    elements.resetButton.addEventListener("click", resetCapture);
    elements.analyzeButton.addEventListener("click", analyzeCurrentMode);

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  function handleBeforeUnload() {
    stopTimer();
    cleanupSpeechRecognition({ abort: true });
    cleanupMediaRecorder({ stop: true });
    stopMicrophoneTracks();
    clearAudioUrl();
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "hidden" || !app.state.isCapturing) {
      return;
    }

    if (isSpeechMode()) {
      stopSpeechCapture("manual");
      return;
    }

    stopHummingRecording({ force: true, reason: "manual" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
