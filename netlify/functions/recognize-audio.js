const crypto = require("crypto");

const ACRCLOUD_ENDPOINT = "/v1/identify";
const ACRCLOUD_DATA_TYPE = "audio";
const ACRCLOUD_SIGNATURE_VERSION = "1";
const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;

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
    validateEnvironmentVariables();

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

    return createResponse(200, {
      success: true,
      matches,
      raw: acrResult,
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

  return {
    type,
    title: item.title || "",
    artist: artists.join(", ") || "Artista desconhecido",
    album: item.album?.name || "",
    score: Number(item.score || 0),
    releaseDate: item.release_date || "",
    durationMs: item.duration_ms || null,
    acrid: item.acrid || "",
    externalMetadata: item.external_metadata || {},
  };
}

/* =========================
   Helpers
========================= */

function validateEnvironmentVariables() {
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
  const cleanBase64 = String(base64).includes(",")
    ? String(base64).split(",").pop()
    : String(base64);

  return Buffer.from(cleanBase64, "base64");
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
