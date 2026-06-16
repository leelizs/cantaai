const crypto = require("crypto");

const ACRCLOUD_ENDPOINT = "/v1/identify";
const ACRCLOUD_DATA_TYPE = "audio";
const ACRCLOUD_SIGNATURE_VERSION = "1";
const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 20;
const DEFAULT_TIMEOUT_MS = 20000;
const ACRCLOUD_TIMEOUT_MS = 22000;
const GEMINI_TIMEOUT_MS = 30000;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const RECOGNITION_MODES = {
  SPEECH: "speech",
  HUMMING: "humming",
};

const CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NONE: "none",
};

const SCORE_LIMITS = {
  HIGH: 70,
  MEDIUM: 50,
};

class PublicError extends Error {
  constructor({ statusCode = 500, errorType = "unknown", userMessage }) {
    super(userMessage);

    this.statusCode = statusCode;
    this.errorType = errorType;
    this.userMessage = userMessage;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return createResponse(event, 204, null);
  }

  if (event.httpMethod !== "POST") {
    return createResponse(event, 405, {
      success: false,
      error: "Método não permitido.",
      userMessage: "Essa ação não é permitida.",
      errorType: "method_not_allowed",
    });
  }

  try {
    const body = parseRequestBody(event.body);
    const mode = normalizeRecognitionMode(body.mode);
    const audioBase64 = body.audioBase64;
    const mimeType = normalizeMimeType(body.mimeType || "audio/webm");
    const durationSeconds = Number(body.durationSeconds || 0);

    if (!audioBase64) {
      throw new PublicError({
        statusCode: 400,
        errorType: "missing_audio",
        userMessage: "Nenhum áudio foi enviado.",
      });
    }

    if (
      durationSeconds &&
      (durationSeconds < 0 || durationSeconds > MAX_AUDIO_DURATION_SECONDS)
    ) {
      throw new PublicError({
        statusCode: 400,
        errorType: "invalid_duration",
        userMessage: "A duração do áudio enviado não parece válida.",
      });
    }

    const audioBuffer = base64ToBuffer(audioBase64);

    if (audioBuffer.length === 0) {
      throw new PublicError({
        statusCode: 400,
        errorType: "empty_audio",
        userMessage: "O áudio enviado está vazio.",
      });
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      throw new PublicError({
        statusCode: 413,
        errorType: "audio_too_large",
        userMessage:
          "O áudio ficou grande demais. Grave um trecho menor e tente novamente.",
      });
    }

    if (mode === RECOGNITION_MODES.SPEECH) {
      validateGeminiEnvironmentVariables();

      const speech = await extractSpeechQueryWithGemini(audioBase64, mimeType);

      return createResponse(event, 200, {
        success: true,
        mode,
        confidence: speech.query ? "speech" : CONFIDENCE.NONE,
        matches: [],
        speech,
        debug: {
          provider: "gemini",
          audioBytes: audioBuffer.length,
          durationSeconds: durationSeconds || null,
        },
      });
    }

    validateAcrCloudEnvironmentVariables();

    const acrResult = await recognizeWithAcrCloud(audioBuffer, mimeType);
    const matches = normalizeAcrCloudResult(acrResult);
    const confidence = getRecognitionConfidence(matches);

    return createResponse(event, 200, {
      success: true,
      mode,
      confidence,
      matches,
      speech: {
        aiUsed: false,
        query: "",
        confidence: 0,
        error: null,
      },
      debug: {
        provider: "acrcloud",
        acrStatus: acrResult.status || null,
        bestScore: matches[0]?.score || 0,
        audioBytes: audioBuffer.length,
        durationSeconds: durationSeconds || null,
      },
    });
  } catch (error) {
    console.error("Erro no reconhecimento:", error);

    const publicError = normalizePublicError(error);

    return createResponse(event, publicError.statusCode, {
      success: false,
      error: publicError.userMessage,
      userMessage: publicError.userMessage,
      errorType: publicError.errorType,
    });
  }
};

/* =========================
   ACRCloud
========================= */

async function recognizeWithAcrCloud(audioBuffer, mimeType) {
  const host = normalizeHost(process.env.ACRCLOUD_HOST);
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;

  const timestamp = Math.floor(Date.now() / 1000).toString();

  const stringToSign = [
    "POST",
    ACRCLOUD_ENDPOINT,
    accessKey,
    ACRCLOUD_DATA_TYPE,
    ACRCLOUD_SIGNATURE_VERSION,
    timestamp,
  ].join("\n");

  const signature = crypto
    .createHmac("sha1", accessSecret)
    .update(Buffer.from(stringToSign, "utf-8"))
    .digest("base64");

  const formData = new FormData();
  const audioBlob = new Blob([audioBuffer], {
    type: mimeType,
  });

  formData.append("sample", audioBlob, getAudioFileName(mimeType));
  formData.append("sample_bytes", String(audioBuffer.length));
  formData.append("access_key", accessKey);
  formData.append("data_type", ACRCLOUD_DATA_TYPE);
  formData.append("signature_version", ACRCLOUD_SIGNATURE_VERSION);
  formData.append("signature", signature);
  formData.append("timestamp", timestamp);

  const response = await fetchWithTimeout(
    `https://${host}${ACRCLOUD_ENDPOINT}`,
    {
      method: "POST",
      body: formData,
    },
    ACRCLOUD_TIMEOUT_MS,
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new PublicError({
      statusCode: 502,
      errorType: "acrcloud_error",
      userMessage:
        "Não foi possível consultar o reconhecimento por áudio agora. Tente novamente em alguns segundos.",
    });
  }

  const data = safeJsonParse(responseText, null);

  if (!data) {
    throw new PublicError({
      statusCode: 502,
      errorType: "acrcloud_invalid_response",
      userMessage:
        "O reconhecimento por áudio retornou uma resposta inválida. Tente novamente.",
    });
  }

  return data;
}

/* =========================
   Gemini para fala
========================= */

async function extractSpeechQueryWithGemini(audioBase64, mimeType) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const cleanBase64 = getCleanBase64(audioBase64);

  const prompt = `
Você é uma IA do CantaAI.

Analise o áudio enviado.

Objetivo:
- Se a pessoa falou algo parecido com nome de música, artista ou trecho de letra, transforme em uma busca textual curta.
- Corrija erros prováveis de pronúncia.
- Se a pessoa apenas cantarolou sem palavras reconhecíveis, retorne query vazia.
- Se a fala estiver confusa demais, retorne query vazia.
- Não invente música sem indícios claros.

Exemplos:

Fala: "bad michael jackson"
Resposta:
{
  "query": "bad michael jackson",
  "confidence": 90
}

Fala: "bad gai bilie"
Resposta:
{
  "query": "bad guy billie eilish",
  "confidence": 85
}

Fala: "quéri on uei uarde son"
Resposta:
{
  "query": "carry on wayward son",
  "confidence": 80
}

Áudio só cantarola sem palavras:
{
  "query": "",
  "confidence": 0
}

Retorne apenas JSON válido neste formato:
{
  "query": "texto da busca ou vazio",
  "confidence": 0
}
`;

  const url = `${GEMINI_API_BASE_URL}/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
              {
                inlineData: {
                  mimeType,
                  data: cleanBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 128,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
              confidence: {
                type: "number",
              },
            },
            required: ["query", "confidence"],
          },
        },
      }),
    },
    GEMINI_TIMEOUT_MS,
  );

  const responseText = await response.text();

  if (!response.ok) {
    if (isQuotaError(response.status, responseText)) {
      throw new PublicError({
        statusCode: 429,
        errorType: "gemini_quota_exceeded",
        userMessage:
          "O limite diário da IA foi atingido. Tente novamente mais tarde ou use o modo Cantarolar.",
      });
    }

    throw new PublicError({
      statusCode: 502,
      errorType: "gemini_error",
      userMessage:
        "A IA não conseguiu interpretar essa gravação agora. Tente novamente em alguns segundos.",
    });
  }

  const data = safeJsonParse(responseText, {});
  const content = extractGeminiText(data);

  if (!content) {
    return {
      aiUsed: true,
      query: "",
      confidence: 0,
      error: null,
    };
  }

  const parsed = safeJsonParse(stripJsonMarkdown(content), {});

  return {
    aiUsed: true,
    query: normalizeSpeechQuery(parsed.query),
    confidence: clampNumber(parsed.confidence, 0, 100),
    error: null,
  };
}

function extractGeminiText(data) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts)
      ? candidate.content.parts
      : [];

    for (const part of parts) {
      if (typeof part.text === "string") {
        return part.text;
      }
    }
  }

  return "";
}

function stripJsonMarkdown(text) {
  return String(text)
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

/* =========================
   Normalização ACRCloud
========================= */

function normalizeAcrCloudResult(acrResult) {
  const metadata = acrResult.metadata || {};

  const musicResults = Array.isArray(metadata.music) ? metadata.music : [];
  const hummingResults = Array.isArray(metadata.humming)
    ? metadata.humming
    : [];

  const normalizedHumming = hummingResults.map((item) =>
    normalizeTrack(item, "humming"),
  );

  const normalizedMusic = musicResults.map((item) =>
    normalizeTrack(item, "music"),
  );

  return removeDuplicatedTracks([...normalizedHumming, ...normalizedMusic])
    .filter((item) => item.title)
    .sort((a, b) => b.score - a.score);
}

function normalizeTrack(item, type) {
  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => artist.name).filter(Boolean)
    : [];

  const externalMetadata = item.external_metadata || {};

  return {
    type,
    title: String(item.title || "").trim(),
    artist: artists.join(", ") || "Artista desconhecido",
    album: item.album?.name || "",
    score: clampNumber(item.score, 0, 100),
    releaseDate: item.release_date || "",
    durationMs: Number(item.duration_ms || 0) || null,
    acrid: item.acrid || "",
    links: createExternalLinks(externalMetadata),
  };
}

function createExternalLinks(externalMetadata) {
  const links = {};

  const deezerTrackId = externalMetadata.deezer?.track?.id;
  const spotifyTrackId = externalMetadata.spotify?.track?.id;
  const youtubeVideoId = externalMetadata.youtube?.vid;

  if (deezerTrackId) {
    links.deezer = `https://www.deezer.com/track/${encodeURIComponent(deezerTrackId)}`;
  }

  if (spotifyTrackId) {
    links.spotify = `https://open.spotify.com/track/${encodeURIComponent(spotifyTrackId)}`;
  }

  if (youtubeVideoId) {
    links.youtube = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`;
  }

  return links;
}

function getRecognitionConfidence(matches) {
  if (!matches.length) {
    return CONFIDENCE.NONE;
  }

  const bestScore = Number(matches[0].score || 0);

  if (bestScore >= SCORE_LIMITS.HIGH) {
    return CONFIDENCE.HIGH;
  }

  if (bestScore >= SCORE_LIMITS.MEDIUM) {
    return CONFIDENCE.MEDIUM;
  }

  return CONFIDENCE.LOW;
}

/* =========================
   Helpers
========================= */

function parseRequestBody(body) {
  try {
    return JSON.parse(body || "{}");
  } catch (error) {
    throw new PublicError({
      statusCode: 400,
      errorType: "invalid_json",
      userMessage: "O corpo da requisição está inválido.",
    });
  }
}

function normalizeRecognitionMode(mode) {
  if (mode === RECOGNITION_MODES.HUMMING) {
    return RECOGNITION_MODES.HUMMING;
  }

  if (mode === RECOGNITION_MODES.SPEECH) {
    return RECOGNITION_MODES.SPEECH;
  }

  return RECOGNITION_MODES.SPEECH;
}

function validateAcrCloudEnvironmentVariables() {
  const requiredVariables = [
    "ACRCLOUD_HOST",
    "ACRCLOUD_ACCESS_KEY",
    "ACRCLOUD_ACCESS_SECRET",
  ];

  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName],
  );

  if (missingVariables.length > 0) {
    throw new PublicError({
      statusCode: 500,
      errorType: "acrcloud_not_configured",
      userMessage:
        "O reconhecimento por cantarolado ainda não está configurado corretamente.",
    });
  }
}

function validateGeminiEnvironmentVariables() {
  if (!process.env.GEMINI_API_KEY) {
    throw new PublicError({
      statusCode: 500,
      errorType: "gemini_not_configured",
      userMessage: "A busca por fala ainda não está configurada corretamente.",
    });
  }
}

function normalizePublicError(error) {
  if (error instanceof PublicError) {
    return error;
  }

  const message = String(error?.message || "");
  const lowerMessage = message.toLowerCase();

  if (isQuotaError(null, message)) {
    return new PublicError({
      statusCode: 429,
      errorType: "quota_exceeded",
      userMessage:
        "O limite diário da IA foi atingido. Tente novamente mais tarde ou use o modo Cantarolar.",
    });
  }

  if (lowerMessage.includes("abort") || lowerMessage.includes("timeout")) {
    return new PublicError({
      statusCode: 504,
      errorType: "timeout",
      userMessage:
        "A análise demorou demais. Tente novamente com uma gravação mais clara.",
    });
  }

  return new PublicError({
    statusCode: 500,
    errorType: "unknown",
    userMessage:
      "Não conseguimos analisar essa gravação agora. Tente novamente em alguns segundos.",
  });
}

function isQuotaError(statusCode, text) {
  const message = String(text || "").toLowerCase();

  return (
    statusCode === 429 ||
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("429")
  );
}

function normalizeHost(host) {
  return String(host || "")
    .replace("https://", "")
    .replace("http://", "")
    .replace(/\/$/, "")
    .trim();
}

function base64ToBuffer(base64) {
  const cleanBase64 = getCleanBase64(base64);

  if (!isProbablyBase64(cleanBase64)) {
    throw new PublicError({
      statusCode: 400,
      errorType: "invalid_audio_base64",
      userMessage: "O áudio enviado está em um formato inválido.",
    });
  }

  return Buffer.from(cleanBase64, "base64");
}

function getCleanBase64(base64) {
  const text = String(base64 || "");

  return text.includes(",") ? text.split(",").pop() : text;
}

function isProbablyBase64(value) {
  const text = String(value || "").trim();

  if (!text || text.length % 4 === 1) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function normalizeMimeType(mimeType) {
  const allowedMimeTypes = [
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/ogg",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
  ];

  const cleanMimeType = String(mimeType || "audio/webm")
    .toLowerCase()
    .trim();

  if (allowedMimeTypes.includes(cleanMimeType)) {
    return cleanMimeType;
  }

  return "audio/webm";
}

function getAudioFileName(mimeType) {
  if (mimeType.includes("mp4")) {
    return "recording.m4a";
  }

  if (mimeType.includes("ogg")) {
    return "recording.ogg";
  }

  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "recording.mp3";
  }

  if (mimeType.includes("wav")) {
    return "recording.wav";
  }

  return "recording.webm";
}

function normalizeSpeechQuery(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function removeDuplicatedTracks(tracks) {
  const unique = new Map();

  tracks.forEach((track) => {
    const key =
      track.acrid ||
      `${normalizeText(track.title)}:${normalizeText(track.artist)}`;

    if (key && !unique.has(key)) {
      unique.set(key, track);
    }
  });

  return Array.from(unique.values());
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function clampNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(Math.max(number, min), max);
}

function safeJsonParse(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallbackValue;
  }
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  if (!globalThis.AbortController) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getAllowedOrigin(event) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const requestOrigin = event.headers?.origin || event.headers?.Origin || "";

  if (allowedOrigin === "*") {
    return "*";
  }

  const allowedOrigins = allowedOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0] || "*";
}

function createResponse(event, statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": getAllowedOrigin(event),
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: body === null ? "" : JSON.stringify(body),
  };
}
