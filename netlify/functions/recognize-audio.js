const crypto = require("crypto");

const ACRCLOUD_ENDPOINT = "/v1/identify";
const ACRCLOUD_DATA_TYPE = "audio";
const ACRCLOUD_SIGNATURE_VERSION = "1";
const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;

const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

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

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return createResponse(200, {});
  }

  if (event.httpMethod !== "POST") {
    return createResponse(405, {
      error: "Método não permitido.",
    });
  }

  try {
    validateAcrCloudEnvironmentVariables();

    const body = JSON.parse(event.body || "{}");

    const audioBase64 = body.audioBase64;
    const mimeType = body.mimeType || "audio/webm";

    if (!audioBase64) {
      return createResponse(400, {
        error: "Nenhum áudio foi enviado.",
      });
    }

    const audioBuffer = base64ToBuffer(audioBase64);

    if (audioBuffer.length === 0) {
      return createResponse(400, {
        error: "O áudio enviado está vazio.",
      });
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      return createResponse(413, {
        error:
          "O áudio ficou grande demais. Grave um trecho menor, de até 15 segundos.",
      });
    }

    const acrResult = await recognizeWithAcrCloud(audioBuffer, mimeType);
    const matches = normalizeAcrCloudResult(acrResult);
    const confidence = getRecognitionConfidence(matches);

    const speech = await tryExtractSpeechQuery({
      audioBase64,
      mimeType,
      shouldTry: confidence !== CONFIDENCE.HIGH,
    });

    return createResponse(200, {
      success: true,
      confidence,
      matches,
      speech,
      debug: {
        acrStatus: acrResult.status || null,
        bestScore: matches[0]?.score || 0,
      },
    });
  } catch (error) {
    console.error("Erro no reconhecimento:", error);

    return createResponse(500, {
      success: false,
      error: error.message || "Erro ao reconhecer áudio.",
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

  const response = await fetch(`https://${host}${ACRCLOUD_ENDPOINT}`, {
    method: "POST",
    body: formData,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Erro da ACRCloud: ${response.status} - ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error("A ACRCloud retornou uma resposta inválida.");
  }
}

/* =========================
   Gemini fallback para fala
========================= */

async function tryExtractSpeechQuery({ audioBase64, mimeType, shouldTry }) {
  if (!shouldTry) {
    return {
      aiUsed: false,
      query: "",
      confidence: 0,
      error: null,
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      aiUsed: false,
      query: "",
      confidence: 0,
      error: "GEMINI_API_KEY não configurada.",
    };
  }

  try {
    return await extractSpeechQueryWithGemini(audioBase64, mimeType);
  } catch (error) {
    console.error("Erro no fallback Gemini:", error);

    return {
      aiUsed: false,
      query: "",
      confidence: 0,
      error: error.message || "Erro ao interpretar fala com Gemini.",
    };
  }
}

async function extractSpeechQueryWithGemini(audioBase64, mimeType) {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const cleanBase64 = getCleanBase64(audioBase64);

  const prompt = `
Você é uma IA do CantaAI.

Analise o áudio enviado.

Objetivo:
- Se a pessoa falou algo parecido com nome de música, artista ou trecho de letra, transforme em uma busca textual curta.
- Se a pessoa apenas cantarolou sem palavras reconhecíveis, retorne query vazia.
- Se a fala estiver confusa demais, retorne query vazia.
- Não invente música sem indícios claros.

Exemplos:
Áudio fala: "bad michael jackson"
Resposta:
{
  "query": "bad michael jackson",
  "confidence": 90
}

Áudio fala: "bad gai bilie"
Resposta:
{
  "query": "bad guy billie eilish",
  "confidence": 85
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
  )}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Falha ao chamar Gemini: ${response.status} - ${errorText}`,
    );
  }

  const data = await response.json();
  const content = extractGeminiText(data);

  if (!content) {
    return {
      aiUsed: true,
      query: "",
      confidence: 0,
      error: "Gemini não retornou texto.",
    };
  }

  const parsed = JSON.parse(stripJsonMarkdown(content));

  return {
    aiUsed: true,
    query: String(parsed.query || "").trim(),
    confidence: Number(parsed.confidence || 0),
    error: null,
  };
}

function extractGeminiText(data) {
  const candidates = data.candidates || [];

  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];

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
   Normalização do resultado
========================= */

function normalizeAcrCloudResult(acrResult) {
  const metadata = acrResult.metadata || {};

  const musicResults = Array.isArray(metadata.music) ? metadata.music : [];
  const hummingResults = Array.isArray(metadata.humming)
    ? metadata.humming
    : [];

  const normalizedMusic = musicResults.map((item) =>
    normalizeTrack(item, "music"),
  );

  const normalizedHumming = hummingResults.map((item) =>
    normalizeTrack(item, "humming"),
  );

  return [...normalizedHumming, ...normalizedMusic]
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
    title: item.title || "",
    artist: artists.join(", ") || "Artista desconhecido",
    album: item.album?.name || "",
    score: Number(item.score || 0),
    releaseDate: item.release_date || "",
    durationMs: item.duration_ms || null,
    acrid: item.acrid || "",
    externalMetadata,
    links: createExternalLinks(externalMetadata),
  };
}

function createExternalLinks(externalMetadata) {
  const links = {};

  const deezerTrackId = externalMetadata.deezer?.track?.id;
  const spotifyTrackId = externalMetadata.spotify?.track?.id;
  const youtubeVideoId = externalMetadata.youtube?.vid;

  if (deezerTrackId) {
    links.deezer = `https://www.deezer.com/track/${deezerTrackId}`;
  }

  if (spotifyTrackId) {
    links.spotify = `https://open.spotify.com/track/${spotifyTrackId}`;
  }

  if (youtubeVideoId) {
    links.youtube = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
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
    throw new Error(
      `Variáveis ausentes no Netlify: ${missingVariables.join(", ")}`,
    );
  }
}

function normalizeHost(host) {
  return String(host)
    .replace("https://", "")
    .replace("http://", "")
    .replace(/\/$/, "")
    .trim();
}

function base64ToBuffer(base64) {
  return Buffer.from(getCleanBase64(base64), "base64");
}

function getCleanBase64(base64) {
  return String(base64).includes(",")
    ? String(base64).split(",").pop()
    : String(base64);
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

  return "recording.webm";
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
