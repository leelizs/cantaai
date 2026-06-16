const DEEZER_API_URL = "https://api.deezer.com/search";
const OPENAI_API_URL = "https://api.openai.com/v1/responses";

const MAX_AI_TERMS = 6;
const DEEZER_LIMIT = 10;
const MAX_RESULTS = 12;

exports.handler = async function (event) {
  try {
    const query = event.queryStringParameters?.query?.trim();

    if (!query) {
      return createResponse(400, {
        error: "Digite algo para buscar.",
      });
    }

    const searchTerms = await createSmartSearchTerms(query);
    const deezerResults = await searchMultipleTermsOnDeezer(searchTerms);
    const uniqueResults = removeDuplicatedMusics(deezerResults);
    const rankedResults = rankResults(query, searchTerms, uniqueResults);

    return createResponse(200, {
      originalQuery: query,
      searchTerms,
      results: rankedResults.slice(0, MAX_RESULTS),
    });
  } catch (error) {
    console.error(error);

    return createResponse(500, {
      error: "Erro ao buscar músicas.",
    });
  }
};

/* =========================
   IA: melhora a busca
========================= */

async function createSmartSearchTerms(query) {
  const fallbackTerms = createFallbackSearchTerms(query);

  if (!process.env.OPENAI_API_KEY) {
    return fallbackTerms;
  }

  try {
    const aiTerms = await generateSearchTermsWithAI(query);

    const mergedTerms = [...aiTerms, ...fallbackTerms];

    return removeDuplicatedStrings(mergedTerms).slice(0, MAX_AI_TERMS);
  } catch (error) {
    console.error("Erro na IA:", error);
    return fallbackTerms;
  }
}

async function generateSearchTermsWithAI(query) {
  const prompt = `
Você é uma IA especializada em busca musical.

O usuário pode digitar nomes de músicas, artistas ou trechos de letra de forma errada, incompleta ou fonética.

Sua tarefa é gerar até ${MAX_AI_TERMS} termos curtos de busca para APIs musicais como Deezer, Spotify, Last.fm e MusicBrainz.

Regras:
- Retorne apenas JSON válido.
- Não explique nada.
- Não invente uma música específica se não houver indícios.
- Corrija erros fonéticos prováveis.
- Mantenha termos úteis para busca musical.
- Inclua variações com artista quando fizer sentido.
- A resposta deve seguir este formato:
{
  "terms": ["termo 1", "termo 2", "termo 3"]
}

Entrada do usuário:
"${query}"
`;

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error("Falha ao chamar OpenAI");
  }

  const data = await response.json();
  const outputText = extractOpenAIText(data);
  const parsed = JSON.parse(outputText);

  if (!Array.isArray(parsed.terms)) {
    return [];
  }

  return parsed.terms.map((term) => String(term).trim()).filter(Boolean);
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const output = data.output || [];

  for (const item of output) {
    const content = item.content || [];

    for (const contentItem of content) {
      if (contentItem.type === "output_text" && contentItem.text) {
        return contentItem.text;
      }
    }
  }

  return "";
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

  words.forEach((word) => {
    if (word.length >= 3) {
      terms.add(word);
    }
  });

  for (let i = 0; i < words.length - 1; i++) {
    terms.add(`${words[i]} ${words[i + 1]}`);
  }

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
  const url = `${DEEZER_API_URL}?q=${encodeURIComponent(term)}&limit=${DEEZER_LIMIT}`;

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
   Ranking
========================= */

function rankResults(originalQuery, searchTerms, musics) {
  return musics
    .map((music) => ({
      id: music.id,
      title: music.title,
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

  let score = 0;

  if (fullText.includes(query)) {
    score += 80;
  }

  if (title.includes(query)) {
    score += 90;
  }

  if (artist.includes(query)) {
    score += 50;
  }

  searchTerms.forEach((term) => {
    const normalizedTerm = normalizeText(term);

    if (title.includes(normalizedTerm)) {
      score += 65;
    }

    if (artist.includes(normalizedTerm)) {
      score += 45;
    }

    if (fullText.includes(normalizedTerm)) {
      score += 40;
    }

    const termSimilarityWithTitle = getTextSimilarity(normalizedTerm, title);
    const termSimilarityWithArtist = getTextSimilarity(normalizedTerm, artist);

    if (termSimilarityWithTitle >= 0.75) {
      score += 55;
    }

    if (termSimilarityWithArtist >= 0.75) {
      score += 35;
    }
  });

  const queryWords = query.split(" ").filter(Boolean);
  const musicWords = fullText.split(" ").filter(Boolean);

  queryWords.forEach((queryWord) => {
    const bestScore = musicWords.reduce((best, musicWord) => {
      const similarity = getTextSimilarity(queryWord, musicWord);
      return Math.max(best, similarity);
    }, 0);

    if (bestScore >= 0.8) {
      score += 25;
    } else if (bestScore >= 0.65) {
      score += 15;
    }
  });

  if (music.rank) {
    score += Math.min(music.rank / 100000, 15);
  }

  return Math.min(Math.round(score), 99);
}

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
    },
    body: JSON.stringify(body),
  };
}
