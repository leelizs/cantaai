const elements = {
  startButton: document.getElementById("startRecordButton"),
  stopButton: document.getElementById("stopRecordButton"),
  resetButton: document.getElementById("resetRecordButton"),
  analyzeButton: document.getElementById("analyzeButton"),
  audioPreview: document.getElementById("audioPreview"),
  statusText: document.getElementById("status"),
  recordTimer: document.getElementById("recordTimer"),
  recorderVisual: document.getElementById("recorderVisual"),
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

function resetAudioState() {
  clearAudioUrl();

  state.audioChunks = [];
  state.audioBlob = null;
  state.recordedDurationSeconds = 0;

  elements.audioPreview.src = "";
  elements.audioPreview.hidden = true;
  elements.recordTimer.textContent = "00:00";
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

    if (!data.matches || data.matches.length === 0) {
      setStatus(
        "Não encontramos nenhuma música parecida. Tente gravar um trecho mais claro.",
      );
      return;
    }

    const bestMatch = data.matches[0];

    setStatus(`Melhor resultado: ${bestMatch.title} - ${bestMatch.artist}`);

    console.log("Resultado ACRCloud:", data);
  } catch (error) {
    console.log(error);
    setStatus(error.message || "Erro ao analisar gravação.");
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
