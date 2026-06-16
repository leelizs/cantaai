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

const state = {
  mediaStream: null,
  mediaRecorder: null,
  audioChunks: [],
  audioBlob: null,
  audioUrl: null,
  timerInterval: null,
  startedAt: null,
  isRecording: false,
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

function updateTimer() {
  if (!state.startedAt) {
    elements.recordTimer.textContent = "00:00";
    return;
  }

  const elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
  elements.recordTimer.textContent = formatTime(elapsedSeconds);
}

function startTimer() {
  state.startedAt = Date.now();
  updateTimer();

  state.timerInterval = setInterval(updateTimer, 500);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.startedAt = null;
}

function setRecordingUI(isRecording) {
  state.isRecording = isRecording;

  elements.startButton.disabled = isRecording;
  elements.stopButton.disabled = !isRecording;
  elements.resetButton.disabled = isRecording || !state.audioBlob;
  elements.analyzeButton.disabled = isRecording || !state.audioBlob;

  elements.recorderVisual.classList.toggle("is-recording", isRecording);
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

    setStatus("Gravando... cante ou cantarole por alguns segundos.");
  } catch (error) {
    console.log(error);
    setStatus(getFriendlyMicrophoneError(error));
    setRecordingUI(false);
  }
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
    return;
  }

  state.mediaRecorder.stop();
  stopTimer();
  setRecordingUI(false);

  setStatus("Gravação finalizada. Você pode ouvir antes de analisar.");
}

function handleDataAvailable(event) {
  if (event.data && event.data.size > 0) {
    state.audioChunks.push(event.data);
  }
}

function handleRecordingStop() {
  const mimeType = state.mediaRecorder.mimeType || "audio/webm";

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

function resetRecording() {
  if (state.isRecording) {
    return;
  }

  resetAudioState();
  setRecordingUI(false);
  setStatus("Clique em começar e grave novamente.");
}

function analyzeRecording() {
  if (!state.audioBlob) {
    setStatus("Grave um áudio antes de analisar.");
    return;
  }

  setStatus(
    "Gravação pronta. Próximo passo: enviar esse áudio para o backend com ACRCloud.",
  );
}

/* =========================
   Eventos
========================= */

elements.startButton.addEventListener("click", startRecording);
elements.stopButton.addEventListener("click", stopRecording);
elements.resetButton.addEventListener("click", resetRecording);
elements.analyzeButton.addEventListener("click", analyzeRecording);

window.addEventListener("beforeunload", () => {
  stopMicrophoneTracks();
  clearAudioUrl();
});
