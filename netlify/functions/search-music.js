const DEEZER_API_URL = "https://api.deezer.com/search";
const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_AI_TERMS = 8;
const DEEZER_LIMIT = 10;
const MAX_RESULTS = 12;

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return createResponse(200, {});
  }

  try {
    const query = event.queryStringParameters?.query?.trim();
    const useAi = parseUseAi(event.queryStringParameters?.useAi);

    if (!query) {
      return createResponse(400, {
        error: "Digite algo para buscar.",
      });
    }

    const smartSearch = await createSmartSearchTerms(query, {
      useAi,
    });

    const deezerResults = await searchMultipleTermsOnDeezer(smartSearch.terms);
    const uniqueResults = removeDuplicatedMusics(deezerResults);
    const rankedResults = rankResults(query, smartSearch.terms, uniqueResults);

    return createResponse(200, {
      originalQuery: query,
      searchTerms: smartSearch.terms,
      debug: {
        aiProvider: smartSearch.aiRequested ? "gemini" : "none",
        aiRequested: smartSearch.aiRequested,
        aiUsed: smartSearch.aiUsed,
        aiSkipped: smartSearch.aiSkipped,
        aiError: smartSearch.aiError,
      },
      results: rankedResults.slice(0, MAX_RESULTS),
    });
  } catch (error) {
    console.error("Erro geral:", error);

    return createResponse(500, {
      error: "Erro ao buscar músicas.",
      userMessage:
        "Não conseguimos buscar músicas agora. Tente novamente em alguns segundos.",
    });
  }
};

/* =========================
   IA: cria termos melhores
========================= */

async function createSmartSearchTerms(query, options = {}) {
  const { useAi = true } = options;
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
      terms: removeDuplicatedStrings(mergedTerms).slice(0, MAX_AI_TERMS),
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
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

  const prompt = `
Você é uma IA especializada em busca musical.

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
- Os termos devem ser curtos e úteis.
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
"${query}"
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
    return [];
  }

  const parsed = JSON.parse(stripJsonMarkdown(content));

  if (!Array.isArray(parsed.terms)) {
    return [];
  }

  return parsed.terms.map((term) => String(term).trim()).filter(Boolean);
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
   Fallback sem IA
========================= */

function createFallbackSearchTerms(query) {
  const normalizedQuery = normalizeText(query);

  const words = normalizedQuery.split(" ").filter((word) => word.length >= 2);

  const terms = new Set();

  terms.add(query);
  terms.add(normalizedQuery);

  if (words.length > 1) {
    terms.add(words.join(" "));
  }

  for (let i = 0; i < words.length - 1; i++) {
    terms.add(`${words[i]} ${words[i + 1]}`);
  }

  if (words.length >= 3) {
    terms.add(words.slice(0, 3).join(" "));
  }

  words.forEach((word) => {
    if (word.length >= 3) {
      terms.add(word);
    }
  });

  return Array.from(terms).slice(0, MAX_AI_TERMS);
}

/* =========================
   Deezer
========================= */

async function searchMultipleTermsOnDeezer(terms) {
  const allResults = [];

  for (const term of terms) {
    try {
      const results = await searchDeezer(term);
      allResults.push(...results);
    } catch (error) {
      console.error(`Erro buscando termo "${term}":`, error);
    }
  }

  return allResults;
}

async function searchDeezer(term) {
  const url = `${DEEZER_API_URL}?q=${encodeURIComponent(
    term,
  )}&limit=${DEEZER_LIMIT}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Erro na Deezer API");
  }

  const data = await response.json();

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
      id: music.id,
      title: music.title || "Título desconhecido",
      artist: {
        name: music.artist?.name || "Artista desconhecido",
      },
      album: {
        title: music.album?.title || "",
        cover_medium: music.album?.cover_medium || "",
      },
      preview: music.preview || "",
      link: music.link || "",
      rank: music.rank || 0,
      similarity: calculateSimilarity(originalQuery, searchTerms, music),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

function calculateSimilarity(originalQuery, searchTerms, music) {
  const query = normalizeText(originalQuery);
  const title = normalizeText(music.title || "");
  const artist = normalizeText(music.artist?.name || "");
  const album = normalizeText(music.album?.title || "");
  const fullText = `${title} ${artist} ${album}`;

  const queryWords = query.split(" ").filter(Boolean);
  const musicWords = fullText.split(" ").filter(Boolean);

  let score = 0;

  const wordMatches = queryWords.map((queryWord) => {
    const bestSimilarity = musicWords.reduce((best, musicWord) => {
      const similarity = getTextSimilarity(queryWord, musicWord);
      return Math.max(best, similarity);
    }, 0);

    return bestSimilarity;
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

    if (termWords.length >= 2 && title.includes(normalizedTerm)) {
      score += 85;
    }

    if (termWords.length >= 2 && fullText.includes(normalizedTerm)) {
      score += 70;
    }

    if (termWords.length >= 2 && artist.includes(normalizedTerm)) {
      score += 35;
    }

    const termSimilarityWithTitle = getTextSimilarity(normalizedTerm, title);
    const termSimilarityWithFullText = getTextSimilarity(
      normalizedTerm,
      fullText,
    );

    if (termWords.length >= 2 && termSimilarityWithTitle >= 0.72) {
      score += 60;
    }

    if (termWords.length >= 2 && termSimilarityWithFullText >= 0.72) {
      score += 45;
    }
  });

  const queryHasMultipleWords = queryWords.length >= 2;
  const matchedFewWords = mediumMatches <= 1;

  if (queryHasMultipleWords && matchedFewWords) {
    score -= 35;
  }

  if (music.rank) {
    score += Math.min(music.rank / 200000, 8);
  }

  return Math.max(Math.min(Math.round(score), 99), 0);
}

/* =========================
   Similaridade
========================= */

function getTextSimilarity(textA, textB) {
  const a = normalizeText(textA);
  const b = normalizeText(textB);

  if (!a || !b) {
    return 0;
  }

  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

function levenshtein(textA, textB) {
  const a = normalizeText(textA);
  const b = normalizeText(textB);

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const hasSameLetter = b.charAt(i - 1) === a.charAt(j - 1);

      matrix[i][j] = hasSameLetter
        ? matrix[i - 1][j - 1]
        : Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
    }
  }

  return matrix[b.length][a.length];
}

/* =========================
   Utilidades
========================= */

function parseUseAi(value) {
  if (value === undefined || value === null) {
    return true;
  }

  return String(value).toLowerCase() !== "false";
}

function getFriendlyAiError(error) {
  const message = String(error?.message || "");

  if (
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota") ||
    message.includes("429")
  ) {
    return "Limite da IA atingido. Usando busca simples.";
  }

  return message || "Erro desconhecido na IA.";
}

function normalizeText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function removeDuplicatedMusics(musics) {
  const unique = new Map();

  musics.forEach((music) => {
    if (music.id && !unique.has(music.id)) {
      unique.set(music.id, music);
    }
  });

  return Array.from(unique.values());
}

function removeDuplicatedStrings(strings) {
  const unique = new Set();

  strings.forEach((item) => {
    const normalized = normalizeText(item);

    if (normalized) {
      unique.add(normalized);
    }
  });

  return Array.from(unique);
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
