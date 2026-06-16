const DEEZER_API_URL = "https://api.deezer.com/search";
const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_QUERY_LENGTH = 180;
const MAX_AI_TERMS = 8;
const DEEZER_LIMIT = 10;
const MAX_RESULTS = 12;
const DEFAULT_TIMEOUT_MS = 12000;
const DEEZER_TIMEOUT_MS = 9000;
const GEMINI_TIMEOUT_MS = 15000;

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

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

  if (event.httpMethod !== "GET") {
    return createResponse(event, 405, {
      error: "Método não permitido.",
      userMessage: "Essa ação não é permitida.",
      errorType: "method_not_allowed",
    });
  }

  try {
    const query = normalizeUserQuery(event.queryStringParameters?.query);
    const useAi = parseUseAi(event.queryStringParameters?.useAi);

    if (!query) {
      throw new PublicError({
        statusCode: 400,
        errorType: "missing_query",
        userMessage: "Digite algo para buscar.",
      });
    }

    const smartSearch = await createSmartSearchTerms(query, { useAi });
    const deezerResults = await searchMultipleTermsOnDeezer(smartSearch.terms);
    const uniqueResults = removeDuplicatedMusics(deezerResults);
    const rankedResults = rankResults(query, smartSearch.terms, uniqueResults);

    return createResponse(event, 200, {
      success: true,
      originalQuery: query,
      searchTerms: smartSearch.terms,
      debug: {
        aiProvider: smartSearch.aiRequested ? "gemini" : "none",
        aiRequested: smartSearch.aiRequested,
        aiUsed: smartSearch.aiUsed,
        aiSkipped: smartSearch.aiSkipped,
        aiError: smartSearch.aiError,
        totalRawResults: deezerResults.length,
        totalUniqueResults: uniqueResults.length,
      },
      results: rankedResults.slice(0, MAX_RESULTS),
    });
  } catch (error) {
    console.error("Erro em search-music:", error);

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
   IA: cria termos melhores
========================= */

async function createSmartSearchTerms(query, options = {}) {
  const { useAi = false } = options;
  const fallbackTerms = createFallbackSearchTerms(query);

  if (!useAi) {
    return {
      terms: fallbackTerms,
      aiRequested: false,
      aiUsed: false,
      aiSkipped: true,
      aiError: null,
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      terms: fallbackTerms,
      aiRequested: true,
      aiUsed: false,
      aiSkipped: false,
      aiError: "GEMINI_API_KEY não configurada.",
    };
  }

  try {
    const aiTerms = await generateSearchTermsWithGemini(query);
    const mergedTerms = [...aiTerms, ...fallbackTerms];

    return {
      terms: sanitizeSearchTerms(mergedTerms).slice(0, MAX_AI_TERMS),
      aiRequested: true,
      aiUsed: aiTerms.length > 0,
      aiSkipped: false,
      aiError: null,
    };
  } catch (error) {
    console.error("Erro na IA Gemini:", error);

    return {
      terms: fallbackTerms,
      aiRequested: true,
      aiUsed: false,
      aiSkipped: false,
      aiError: getFriendlyAiError(error),
    };
  }
}

async function generateSearchTermsWithGemini(query) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const safeQuery = normalizeUserQuery(query);

  const prompt = `
Você é uma IA especializada em busca musical para o CantaAI.

O usuário pode digitar:
- nome de música errado;
- artista errado;
- trecho de letra errado;
- palavras fonéticas;
- uma mistura de artista + som aproximado.

Sua tarefa é transformar a busca ruim em termos úteis para APIs musicais como Deezer, Spotify, Last.fm e MusicBrainz.

Regras:
- Retorne apenas JSON válido.
- Não explique nada.
- Não use markdown.
- Gere de 3 a 8 termos de busca.
- Os termos devem ser curtos e pesquisáveis.
- Inclua variações com artista quando fizer sentido.
- Não invente uma música específica sem indícios claros.
- Corrija erros fonéticos prováveis.
- Priorize músicas, artistas e combinações pesquisáveis.
- Se o usuário citar artista aproximado, tente transformar em nome correto.
- Se o usuário citar som parecido com título, gere variações do título.

Formato obrigatório:
{
  "terms": ["termo 1", "termo 2", "termo 3"]
}

Exemplos:

Entrada: "bed gui bilie"
Saída:
{
  "terms": ["bad guy billie eilish", "bad guy", "billie eilish bad guy", "billie eilish"]
}

Entrada: "blinding ligths"
Saída:
{
  "terms": ["blinding lights", "the weeknd blinding lights", "blinding lights the weeknd"]
}

Entrada: "beatls yesterday"
Saída:
{
  "terms": ["yesterday the beatles", "the beatles yesterday", "yesterday"]
}

Entrada do usuário:
${JSON.stringify(safeQuery)}
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
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 256,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              terms: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["terms"],
          },
        },
      }),
    },
    GEMINI_TIMEOUT_MS,
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Falha ao chamar Gemini: ${response.status} - ${responseText}`,
    );
  }

  const data = safeJsonParse(responseText, {});
  const content = extractGeminiText(data);

  if (!content) {
    return [];
  }

  const parsed = safeJsonParse(stripJsonMarkdown(content), {});

  if (!Array.isArray(parsed.terms)) {
    return [];
  }

  return sanitizeSearchTerms(parsed.terms).slice(0, MAX_AI_TERMS);
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
   Fallback sem IA
========================= */

function createFallbackSearchTerms(query) {
  const normalizedQuery = normalizeText(query);
  const words = normalizedQuery
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

  const terms = new Set();

  terms.add(normalizeUserQuery(query));
  terms.add(normalizedQuery);

  if (words.length > 1) {
    terms.add(words.join(" "));
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    terms.add(`${words[index]} ${words[index + 1]}`);
  }

  if (words.length >= 3) {
    terms.add(words.slice(0, 3).join(" "));
  }

  words.forEach((word) => {
    if (word.length >= 3) {
      terms.add(word);
    }
  });

  return sanitizeSearchTerms(Array.from(terms)).slice(0, MAX_AI_TERMS);
}

function sanitizeSearchTerms(terms) {
  const unique = new Map();

  terms.forEach((term) => {
    const cleanTerm = normalizeUserQuery(term);
    const normalizedTerm = normalizeText(cleanTerm);

    if (normalizedTerm.length >= 2 && !unique.has(normalizedTerm)) {
      unique.set(normalizedTerm, cleanTerm);
    }
  });

  return Array.from(unique.values()).slice(0, MAX_AI_TERMS);
}

/* =========================
   Deezer
========================= */

async function searchMultipleTermsOnDeezer(terms) {
  const safeTerms = sanitizeSearchTerms(terms);

  if (!safeTerms.length) {
    return [];
  }

  const searches = safeTerms.map(async (term) => {
    try {
      return await searchDeezer(term);
    } catch (error) {
      console.error(`Erro buscando termo "${term}":`, error);
      return [];
    }
  });

  const settledResults = await Promise.allSettled(searches);

  return settledResults.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }

    return result.value;
  });
}

async function searchDeezer(term) {
  const url = `${DEEZER_API_URL}?q=${encodeURIComponent(term)}&limit=${DEEZER_LIMIT}`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
      },
    },
    DEEZER_TIMEOUT_MS,
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Erro na Deezer API: ${response.status}`);
  }

  const data = safeJsonParse(responseText, {});

  if (!Array.isArray(data.data)) {
    return [];
  }

  return data.data;
}

/* =========================
   Ranking dos resultados
========================= */

function rankResults(originalQuery, searchTerms, musics) {
  return musics
    .map((music) => ({
      id: music.id || null,
      title: music.title || "Título desconhecido",
      artist: {
        name: music.artist?.name || "Artista desconhecido",
      },
      album: {
        title: music.album?.title || "",
        cover: music.album?.cover || "",
        cover_medium: music.album?.cover_medium || "",
      },
      preview: isSafeHttpUrl(music.preview) ? music.preview : "",
      link: isSafeHttpUrl(music.link) ? music.link : "",
      rank: Number(music.rank || 0),
      similarity: calculateSimilarity(originalQuery, searchTerms, music),
    }))
    .sort((a, b) => {
      if (b.similarity !== a.similarity) {
        return b.similarity - a.similarity;
      }

      return b.rank - a.rank;
    });
}

function calculateSimilarity(originalQuery, searchTerms, music) {
  const query = normalizeText(originalQuery);
  const title = normalizeText(music.title || "");
  const artist = normalizeText(music.artist?.name || "");
  const album = normalizeText(music.album?.title || "");
  const fullText = `${title} ${artist} ${album}`.trim();

  const queryWords = query.split(" ").filter(Boolean);
  const musicWords = fullText.split(" ").filter(Boolean);

  if (!query || !musicWords.length) {
    return 0;
  }

  let score = 0;

  const wordMatches = queryWords.map((queryWord) => {
    return musicWords.reduce((best, musicWord) => {
      const similarity = getTextSimilarity(queryWord, musicWord);
      return Math.max(best, similarity);
    }, 0);
  });

  const averageWordMatch =
    wordMatches.length > 0
      ? wordMatches.reduce((sum, value) => sum + value, 0) / wordMatches.length
      : 0;

  const strongMatches = wordMatches.filter((value) => value >= 0.75).length;
  const mediumMatches = wordMatches.filter((value) => value >= 0.6).length;

  score += averageWordMatch * 70;
  score += strongMatches * 18;
  score += mediumMatches * 10;

  if (title === query) {
    score += 100;
  }

  if (fullText.includes(query)) {
    score += 80;
  }

  if (title.includes(query)) {
    score += 70;
  }

  if (artist.includes(query)) {
    score += 45;
  }

  searchTerms.forEach((term) => {
    const normalizedTerm = normalizeText(term);

    if (!normalizedTerm || normalizedTerm.length < 4) {
      return;
    }

    const termWords = normalizedTerm.split(" ").filter(Boolean);
    const hasMultipleWords = termWords.length >= 2;

    if (hasMultipleWords && title.includes(normalizedTerm)) {
      score += 85;
    }

    if (hasMultipleWords && fullText.includes(normalizedTerm)) {
      score += 70;
    }

    if (hasMultipleWords && artist.includes(normalizedTerm)) {
      score += 35;
    }

    const termSimilarityWithTitle = getTextSimilarity(normalizedTerm, title);
    const termSimilarityWithFullText = getTextSimilarity(
      normalizedTerm,
      fullText,
    );

    if (hasMultipleWords && termSimilarityWithTitle >= 0.72) {
      score += 60;
    }

    if (hasMultipleWords && termSimilarityWithFullText >= 0.72) {
      score += 45;
    }
  });

  const queryHasMultipleWords = queryWords.length >= 2;
  const matchedFewWords = mediumMatches <= 1;

  if (queryHasMultipleWords && matchedFewWords) {
    score -= 35;
  }

  if (music.rank) {
    score += Math.min(Number(music.rank) / 200000, 8);
  }

  return clampNumber(Math.round(score), 0, 99);
}

/* =========================
   Similaridade
========================= */

function getTextSimilarity(textA, textB) {
  const a = normalizeText(textA).slice(0, 80);
  const b = normalizeText(textB).slice(0, 120);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if (a.length > 3 && b.includes(a)) {
    return 0.92;
  }

  if (b.length > 3 && a.includes(b)) {
    return 0.9;
  }

  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

function levenshtein(textA, textB) {
  const a = normalizeText(textA);
  const b = normalizeText(textB);

  if (a === b) {
    return 0;
  }

  if (!a.length) {
    return b.length;
  }

  if (!b.length) {
    return a.length;
  }

  const previousRow = Array.from({ length: a.length + 1 }, (_, index) => index);
  const currentRow = new Array(a.length + 1);

  for (let i = 1; i <= b.length; i += 1) {
    currentRow[0] = i;

    for (let j = 1; j <= a.length; j += 1) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;

      currentRow[j] = Math.min(
        currentRow[j - 1] + 1,
        previousRow[j] + 1,
        previousRow[j - 1] + cost,
      );
    }

    for (let j = 0; j <= a.length; j += 1) {
      previousRow[j] = currentRow[j];
    }
  }

  return previousRow[a.length];
}

/* =========================
   Utilidades
========================= */

function parseUseAi(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  return ["1", "true", "yes", "sim"].includes(String(value).toLowerCase());
}

function normalizePublicError(error) {
  if (error instanceof PublicError) {
    return error;
  }

  const message = String(error?.message || "").toLowerCase();

  if (
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("429")
  ) {
    return new PublicError({
      statusCode: 429,
      errorType: "quota_exceeded",
      userMessage:
        "Estamos com muitas buscas agora. Tente novamente mais tarde.",
    });
  }

  if (message.includes("abort") || message.includes("timeout")) {
    return new PublicError({
      statusCode: 504,
      errorType: "timeout",
      userMessage:
        "A busca demorou demais. Tente novamente em alguns segundos.",
    });
  }

  return new PublicError({
    statusCode: 500,
    errorType: "unknown",
    userMessage:
      "Não conseguimos buscar músicas agora. Tente novamente em alguns segundos.",
  });
}

function getFriendlyAiError(error) {
  const message = String(error?.message || "");
  const lowerMessage = message.toLowerCase();

  if (
    message.includes("RESOURCE_EXHAUSTED") ||
    lowerMessage.includes("quota") ||
    message.includes("429")
  ) {
    return "Limite da IA atingido. Usando busca simples.";
  }

  if (lowerMessage.includes("abort") || lowerMessage.includes("timeout")) {
    return "A IA demorou demais. Usando busca simples.";
  }

  return "IA indisponível. Usando busca simples.";
}

function normalizeUserQuery(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
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

function removeDuplicatedMusics(musics) {
  const unique = new Map();

  musics.forEach((music) => {
    const id = music.id ? `id:${music.id}` : "";
    const title = normalizeText(music.title || "");
    const artist = normalizeText(music.artist?.name || "");
    const fallbackKey = title || artist ? `text:${title}:${artist}` : "";
    const key = id || fallbackKey;

    if (key && !unique.has(key)) {
      unique.set(key, music);
    }
  });

  return Array.from(unique.values());
}

function isSafeHttpUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function safeJsonParse(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallbackValue;
  }
}

function clampNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(Math.max(number, min), max);
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
    body: body === null ? "" : JSON.stringify(body),
  };
}
