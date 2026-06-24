import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();

app.use(express.json());

app.get("/api/supabase-config", (req, res) => {
  res.set("Cache-Control", "no-store");

  const configured = Boolean(
    SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY,
  );

  return res.json({
    configured,
    url: configured ? SUPABASE_URL : null,
    publishableKey: configured
      ? SUPABASE_PUBLISHABLE_KEY
      : null,
    googleEnabled:
      configured && SUPABASE_GOOGLE_ENABLED,
  });
});

app.use(express.static("public"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const TMDB_TOKEN = process.env.TMDB_TOKEN?.trim();
const TMDB_API_KEY = process.env.TMDB_API_KEY?.trim();
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_PUBLISHABLE_KEY = (
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ""
).trim();
const SUPABASE_GOOGLE_ENABLED =
  String(process.env.SUPABASE_GOOGLE_ENABLED || "false")
    .trim()
    .toLowerCase() === "true";

if (!GEMINI_API_KEY) {
  console.error("❌ Thiếu GEMINI_API_KEY trong file .env");
  process.exit(1);
}

if (!TMDB_TOKEN && !TMDB_API_KEY) {
  console.warn(
    "⚠️ Chưa có TMDB_TOKEN hoặc TMDB_API_KEY. Web vẫn random được nhưng sẽ không có poster.",
  );
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

const movieSchema = {
  type: "object",

  properties: {
    ten_goc: {
      type: "string",
      description: "Tên gốc chính xác của phim theo ngôn ngữ quốc gia sản xuất",
    },

    ten_quoc_te: {
      type: "string",
      description:
        "Tên quốc tế chính thức bằng tiếng Anh, ví dụ Parasite, Your Name, Oldboy",
    },

    ten_viet: {
      type: "string",
      description: "Tên tiếng Việt chính thức hoặc phổ biến của phim",
    },

    nam: {
      type: "integer",
      description: "Năm phát hành chính xác của phim",
    },

    imdb: {
      type: "string",
      description: "Điểm IMDb, ví dụ 8.2/10",
    },

    the_loai: {
      type: "string",
      description: "Thể loại phim",
    },

    quoc_gia: {
      type: "string",
      description: "Quốc gia sản xuất",
    },

    dien_vien: {
      type: "string",
      description: "Các diễn viên nổi bật",
    },

    noi_dung: {
      type: "string",
      description: "Tóm tắt nội dung không spoil, tối đa 3 câu",
    },

    ly_do: {
      type: "string",
      description: "Lý do phim phù hợp với yêu cầu, tối đa 2 câu",
    },

    vibe_poster: {
      type: "string",
      description: "Mô tả ngắn phong cách hình ảnh của phim",
    },

    an_toan_chu_quyen_viet_nam: {
      type: "boolean",
      description:
        "Chỉ true khi chắc chắn phim không tuyên truyền đường lưỡi bò và không xuyên tạc chủ quyền, lãnh thổ Việt Nam",
    },

    ghi_chu_chu_quyen: {
      type: "string",
      description:
        "Ghi chú kiểm tra chủ quyền rất ngắn; nếu không chắc chắn phải nói rõ",
    },
  },

  required: [
    "ten_goc",
    "ten_quoc_te",
    "ten_viet",
    "nam",
    "imdb",
    "the_loai",
    "quoc_gia",
    "dien_vien",
    "noi_dung",
    "ly_do",
    "vibe_poster",
    "an_toan_chu_quyen_viet_nam",
    "ghi_chu_chu_quyen",
  ],

  additionalProperties: false,
};

/**
 * Chuẩn hóa chuỗi để so sánh tên phim.
 */
function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Loại bỏ các tên phim bị trùng.
 */
function getUniqueTitles(movie) {
  const titles = [movie.ten_quoc_te, movie.ten_viet, movie.ten_goc]
    .filter((title) => typeof title === "string")
    .map((title) => title.trim())
    .filter(Boolean);

  return titles.filter((title, index, array) => {
    const normalizedTitle = normalizeText(title);

    return (
      array.findIndex((item) => normalizeText(item) === normalizedTitle) ===
      index
    );
  });
}


const SOVEREIGNTY_RISK_TERMS = [
  "đường lưỡi bò",
  "duong luoi bo",
  "đường chín đoạn",
  "duong chin doan",
  "nine dash line",
  "nine-dash line",
  "nine dotted line",
  "nine-dotted line",
];

const SOVEREIGNTY_BLOCKLIST = String(
  process.env.SOVEREIGNTY_BLOCKLIST || "",
)
  .split(/[,;\n]+/)
  .map((title) => title.trim())
  .filter(Boolean);

function normalizeStringList(value, limit = 30) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n]+/)
      : [];

  const uniqueValues = [];
  const normalizedValues = new Set();

  source.forEach((item) => {
    const cleanItem = String(item || "").trim();

    if (!cleanItem) return;

    const normalizedItem = normalizeText(cleanItem);

    if (
      !normalizedItem ||
      normalizedValues.has(normalizedItem)
    ) {
      return;
    }

    normalizedValues.add(normalizedItem);
    uniqueValues.push(cleanItem);
  });

  return uniqueValues.slice(0, limit);
}

function normalizeExclusions(value) {
  const exclusions =
    value && typeof value === "object"
      ? value
      : {};

  return {
    enabled: exclusions.enabled !== false,
    actors: normalizeStringList(exclusions.actors, 30),
    countries: normalizeStringList(
      exclusions.countries,
      30,
    ),
    genres: normalizeStringList(exclusions.genres, 30),
    years: normalizeStringList(exclusions.years, 30),
    keywords: normalizeStringList(
      exclusions.keywords,
      30,
    ),
  };
}

function parseExcludedYearRule(value) {
  const rule = normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();

  let match = rule.match(/^(\d{4})$/);

  if (match) {
    const year = Number(match[1]);

    return {
      type: "range",
      from: year,
      to: year,
    };
  }

  match = rule.match(/^(\d{4})\s*-\s*(\d{4})$/);

  if (match) {
    return {
      type: "range",
      from: Number(match[1]),
      to: Number(match[2]),
    };
  }

  match = rule.match(/^truoc\s+(\d{4})$/);

  if (match) {
    return {
      type: "before",
      to: Number(match[1]),
    };
  }

  match = rule.match(/^(?:sau|tu)\s+(\d{4})$/);

  if (match) {
    return {
      type: "after",
      from: Number(match[1]),
    };
  }

  return null;
}

function isYearExcluded(year, rules) {
  const numericYear = Number(year);

  if (!Number.isInteger(numericYear)) {
    return false;
  }

  return rules.some((rule) => {
    const parsedRule = parseExcludedYearRule(rule);

    if (!parsedRule) return false;

    if (parsedRule.type === "range") {
      return (
        numericYear >= parsedRule.from &&
        numericYear <= parsedRule.to
      );
    }

    if (parsedRule.type === "before") {
      return numericYear < parsedRule.to;
    }

    if (parsedRule.type === "after") {
      return numericYear > parsedRule.from;
    }

    return false;
  });
}

function textContainsExcludedValue(text, values) {
  const normalizedText = normalizeText(text);

  return values.find((value) => {
    const normalizedValue = normalizeText(value);

    return (
      normalizedValue &&
      normalizedText.includes(normalizedValue)
    );
  });
}

function getExclusionPrompt(exclusions) {
  if (!exclusions.enabled) {
    return "Loại trừ cá nhân đang tắt.";
  }

  return [
    `Diễn viên phải né: ${
      exclusions.actors.join(", ") || "Không có"
    }`,
    `Quốc gia phải né: ${
      exclusions.countries.join(", ") || "Không có"
    }`,
    `Thể loại phải né: ${
      exclusions.genres.join(", ") || "Không có"
    }`,
    `Năm hoặc khoảng năm phải né: ${
      exclusions.years.join(", ") || "Không có"
    }`,
    `Tên phim hoặc từ khóa phải né: ${
      exclusions.keywords.join(", ") || "Không có"
    }`,
  ].join("\n");
}

function validateMovieCandidate(movie, exclusions) {
  const reasons = [];

  if (movie.an_toan_chu_quyen_viet_nam !== true) {
    reasons.push(
      "Không xác nhận được an toàn về chủ quyền Việt Nam",
    );
  }

  const sovereigntyText = [
    movie.ten_goc,
    movie.ten_quoc_te,
    movie.ten_viet,
    movie.noi_dung,
    movie.ly_do,
    movie.ghi_chu_chu_quyen,
  ].join(" ");

  const sovereigntyRisk = textContainsExcludedValue(
    sovereigntyText,
    SOVEREIGNTY_RISK_TERMS,
  );

  if (sovereigntyRisk) {
    reasons.push(
      `Có dấu hiệu liên quan "${sovereigntyRisk}"`,
    );
  }

  const blockedTitle = textContainsExcludedValue(
    [
      movie.ten_goc,
      movie.ten_quoc_te,
      movie.ten_viet,
    ].join(" "),
    SOVEREIGNTY_BLOCKLIST,
  );

  if (blockedTitle) {
    reasons.push(
      `Tên phim nằm trong danh sách chặn chủ quyền: ${blockedTitle}`,
    );
  }

  if (!exclusions.enabled) {
    return reasons;
  }

  const excludedActor = textContainsExcludedValue(
    movie.dien_vien,
    exclusions.actors,
  );

  if (excludedActor) {
    reasons.push(`Có diễn viên bị né: ${excludedActor}`);
  }

  const excludedCountry = textContainsExcludedValue(
    movie.quoc_gia,
    exclusions.countries,
  );

  if (excludedCountry) {
    reasons.push(`Thuộc quốc gia bị né: ${excludedCountry}`);
  }

  const excludedGenre = textContainsExcludedValue(
    movie.the_loai,
    exclusions.genres,
  );

  if (excludedGenre) {
    reasons.push(`Thuộc thể loại bị né: ${excludedGenre}`);
  }

  if (isYearExcluded(movie.nam, exclusions.years)) {
    reasons.push(`Năm ${movie.nam} nằm trong vùng bị né`);
  }

  const searchableText = [
    movie.ten_goc,
    movie.ten_quoc_te,
    movie.ten_viet,
    movie.the_loai,
    movie.quoc_gia,
    movie.dien_vien,
    movie.noi_dung,
    movie.ly_do,
    movie.vibe_poster,
  ].join(" ");

  const excludedKeyword = textContainsExcludedValue(
    searchableText,
    exclusions.keywords,
  );

  if (excludedKeyword) {
    reasons.push(`Khớp từ khóa bị né: ${excludedKeyword}`);
  }

  return reasons;
}

async function validateTmdbExclusions(
  tmdbData,
  exclusions,
) {
  if (
    !exclusions.enabled ||
    !tmdbData?.id ||
    !tmdbData?.media_type
  ) {
    return [];
  }

  try {
    const details = await fetchTmdbJson(
      `/${tmdbData.media_type}/${tmdbData.id}`,
      {
        language: "vi-VN",
        append_to_response: "credits",
      },
    );

    const reasons = [];

    const actors = (details.credits?.cast || [])
      .map((person) => person.name)
      .join(", ");

    const excludedActor = textContainsExcludedValue(
      actors,
      exclusions.actors,
    );

    if (excludedActor) {
      reasons.push(
        `TMDB xác nhận có diễn viên bị né: ${excludedActor}`,
      );
    }

    const countries = [
      ...(details.production_countries || []).map(
        (country) => country.name,
      ),
      ...(details.origin_country || []),
    ].join(", ");

    const excludedCountry = textContainsExcludedValue(
      countries,
      exclusions.countries,
    );

    if (excludedCountry) {
      reasons.push(
        `TMDB xác nhận quốc gia bị né: ${excludedCountry}`,
      );
    }

    const genres = (details.genres || [])
      .map((genre) => genre.name)
      .join(", ");

    const excludedGenre = textContainsExcludedValue(
      genres,
      exclusions.genres,
    );

    if (excludedGenre) {
      reasons.push(
        `TMDB xác nhận thể loại bị né: ${excludedGenre}`,
      );
    }

    const releaseDate =
      details.release_date ||
      details.first_air_date ||
      "";

    const year = Number(releaseDate.slice(0, 4));

    if (isYearExcluded(year, exclusions.years)) {
      reasons.push(
        `TMDB xác nhận năm ${year} nằm trong vùng bị né`,
      );
    }

    return reasons;
  } catch (error) {
    console.warn(
      "⚠️ Không kiểm tra được loại trừ bằng TMDB:",
      error.message,
    );

    return [];
  }
}

/**
 * Thêm thông tin xác thực TMDB.
 *
 * Ưu tiên TMDB_TOKEN dạng Bearer.
 * Nếu không có thì dùng TMDB_API_KEY dạng query parameter.
 */
function applyTmdbAuthentication(url) {
  const headers = {
    accept: "application/json",
  };

  if (TMDB_TOKEN) {
    headers.Authorization = `Bearer ${TMDB_TOKEN}`;
  } else if (TMDB_API_KEY) {
    url.searchParams.set("api_key", TMDB_API_KEY);
  }

  return headers;
}


async function fetchTmdbJson(pathname, params = {}) {
  if (!TMDB_TOKEN && !TMDB_API_KEY) {
    throw new Error("Server chưa được cấu hình TMDB.");
  }

  const url = new URL(
    `https://api.themoviedb.org/3${pathname}`,
  );

  Object.entries(params).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = applyTmdbAuthentication(url);

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `TMDB trả về lỗi ${response.status}: ${errorText}`,
    );
  }

  return response.json();
}

/**
 * Gọi endpoint tìm phim hoặc phim bộ trên TMDB.
 */
async function searchTmdb(endpoint, title, year, useYear = true) {
  if ((!TMDB_TOKEN && !TMDB_API_KEY) || !title) {
    return [];
  }

  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);

  url.searchParams.set("query", title);
  url.searchParams.set("language", "vi-VN");
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("page", "1");

  if (year && useYear) {
    if (endpoint === "movie") {
      url.searchParams.set("primary_release_year", String(year));
    }

    if (endpoint === "tv") {
      url.searchParams.set("first_air_date_year", String(year));
    }
  }

  const headers = applyTmdbAuthentication(url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        `❌ TMDB ${endpoint} lỗi ${response.status} khi tìm "${title}":`,
        errorText,
      );

      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data.results)) {
      return [];
    }

    return data.results.map((item) => ({
      ...item,
      media_type: endpoint,
    }));
  } catch (error) {
    console.error(`❌ Lỗi mạng khi tìm "${title}" trên TMDB:`, error);

    return [];
  }
}

/**
 * Lấy năm phát hành từ kết quả TMDB.
 */
function getTmdbYear(item) {
  const date = item.release_date || item.first_air_date || "";

  const year = Number(date.slice(0, 4));

  return Number.isInteger(year) ? year : null;
}

/**
 * Tính điểm để chọn đúng kết quả TMDB nhất.
 */
function scoreTmdbResult(item, searchedTitle, year) {
  if (!item.poster_path) {
    return -1000;
  }

  const searched = normalizeText(searchedTitle);

  const availableTitles = [
    item.title,
    item.original_title,
    item.name,
    item.original_name,
  ]
    .filter(Boolean)
    .map(normalizeText);

  let score = 0;

  if (availableTitles.includes(searched)) {
    score += 150;
  } else if (
    availableTitles.some(
      (title) => title.includes(searched) || searched.includes(title),
    )
  ) {
    score += 70;
  }

  const resultYear = getTmdbYear(item);

  if (year && resultYear === Number(year)) {
    score += 80;
  } else if (year && resultYear && Math.abs(resultYear - Number(year)) <= 1) {
    score += 20;
  }

  if (item.poster_path) {
    score += 30;
  }

  if (item.original_language) {
    score += 5;
  }

  if (typeof item.popularity === "number") {
    score += Math.min(item.popularity / 10, 20);
  }

  return score;
}

/**
 * Chọn kết quả TMDB phù hợp nhất.
 */
function chooseBestTmdbResult(results, searchedTitle, year) {
  const resultsWithPoster = results.filter((item) => item.poster_path);

  if (!resultsWithPoster.length) {
    return null;
  }

  return resultsWithPoster
    .map((item) => ({
      item,
      score: scoreTmdbResult(item, searchedTitle, year),
    }))
    .sort((a, b) => b.score - a.score)[0]?.item;
}

/**
 * Tìm một tên phim trên cả movie và TV.
 */
async function findTmdbByTitle(title, year) {
  // Lần đầu tìm kèm năm để tăng độ chính xác.
  let [movieResults, tvResults] = await Promise.all([
    searchTmdb("movie", title, year, true),
    searchTmdb("tv", title, year, true),
  ]);

  let allResults = [...movieResults, ...tvResults];

  let bestResult = chooseBestTmdbResult(allResults, title, year);

  if (bestResult) {
    return bestResult;
  }

  // Không tìm được thì thử lại mà không giới hạn năm.
  [movieResults, tvResults] = await Promise.all([
    searchTmdb("movie", title, year, false),
    searchTmdb("tv", title, year, false),
  ]);

  allResults = [...movieResults, ...tvResults];

  bestResult = chooseBestTmdbResult(allResults, title, year);

  return bestResult || null;
}

/**
 * Tìm poster bằng:
 * 1. Tên quốc tế
 * 2. Tên tiếng Việt
 * 3. Tên gốc
 */
async function getTmdbMovieData(movie) {
  if (!TMDB_TOKEN && !TMDB_API_KEY) {
    return null;
  }

  const titles = getUniqueTitles(movie);

  console.log("🔎 Các tên dùng để tìm poster:", titles);

  for (const title of titles) {
    console.log(`🔎 Đang tìm "${title}" (${movie.nam}) trên TMDB...`);

    const result = await findTmdbByTitle(title, movie.nam);

    if (!result?.poster_path) {
      console.log(`⚠️ Không tìm thấy poster bằng tên "${title}"`);

      continue;
    }

    const resultTitle =
      result.title ||
      result.name ||
      result.original_title ||
      result.original_name;

    const posterUrl = `https://image.tmdb.org/t/p/w500` + result.poster_path;

    console.log(`✅ Tìm thấy poster: "${resultTitle}" bằng từ khóa "${title}"`);

    console.log(`🖼️ Poster URL: ${posterUrl}`);

    return {
      id: result.id,
      media_type: result.media_type,
      title: resultTitle,
      poster_url: posterUrl,
      backdrop_url: result.backdrop_path
        ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
        : null,
    };
  }

  console.warn(`⚠️ Không tìm thấy poster TMDB cho phim "${movie.ten_goc}"`);

  return null;
}

app.post("/api/random", async (req, res) => {
  const {
    message,
    history,
    exclusions: rawExclusions,
  } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({
      success: false,
      error: "Thiếu yêu cầu random phim.",
    });
  }

  const exclusions = normalizeExclusions(rawExclusions);

  const watchedMovies = Array.isArray(history)
    ? [
        ...new Set(
          history
            .filter((movie) => typeof movie === "string")
            .map((movie) => movie.trim())
            .filter(Boolean),
        ),
      ].slice(0, 300)
    : [];

  const shuffledWatchedMovies = [...watchedMovies];

  for (
    let index = shuffledWatchedMovies.length - 1;
    index > 0;
    index -= 1
  ) {
    const randomIndex = Math.floor(
      Math.random() * (index + 1),
    );

    [
      shuffledWatchedMovies[index],
      shuffledWatchedMovies[randomIndex],
    ] = [
      shuffledWatchedMovies[randomIndex],
      shuffledWatchedMovies[index],
    ];
  }

  const rejectedCandidates = [];
  const maximumAttempts = 3;

  try {
    console.log(`\n🎲 Yêu cầu random: ${message.trim()}`);

    for (
      let attempt = 1;
      attempt <= maximumAttempts;
      attempt += 1
    ) {
      const randomSeed = randomUUID();

      const prompt = `
Bạn là API chuyên random phim theo yêu cầu của người dùng.

Các luật bắt buộc:

1. Nếu người dùng chỉ nhập "Random", chọn ngẫu nhiên hoàn toàn một bộ phim.

2. Nếu có điều kiện, phải đáp ứng chính xác tất cả điều kiện đó.

3. ĐƯỢC PHÉP chọn phim Việt Nam, phim Trung Quốc, Hồng Kông và Đài Loan.
Không tồn tại lệnh cấm mặc định theo quốc gia.

4. BẢO VỆ CHỦ QUYỀN VIỆT NAM — quy tắc này luôn bật:
   - Tuyệt đối không chọn phim chứa, quảng bá, bình thường hóa hoặc tuyên truyền
     bản đồ "đường lưỡi bò", "đường chín đoạn" hoặc "nine-dash line".
   - Tuyệt đối không chọn phim phủ nhận, xuyên tạc hoặc xúc phạm chủ quyền,
     toàn vẹn lãnh thổ Việt Nam, bao gồm vấn đề Hoàng Sa và Trường Sa.
   - Nếu không chắc chắn về tranh cãi chủ quyền của một phim, không được chọn phim đó.
   - Trường "an_toan_chu_quyen_viet_nam" chỉ được là true khi chắc chắn an toàn.

5. Phải tuân thủ Chế độ loại trừ của người dùng:
${getExclusionPrompt(exclusions)}

6. Mỗi lần chỉ trả về duy nhất một bộ phim.

7. Tránh phim bị đánh giá quá thấp hoặc nổi tiếng vì quá dở.

8. Tên phim và năm phát hành phải chính xác.

9. Trường "ten_quoc_te" bắt buộc là tên quốc tế chính thức bằng tiếng Anh.
Ví dụ:
- Gisaengchung có tên quốc tế là Parasite.
- Kimi no Na wa có tên quốc tế là Your Name.
- Ah-ga-ssi có tên quốc tế là The Handmaiden.

10. Tuyệt đối không chọn lại bất kỳ phim nào trong danh sách sau:
${
  shuffledWatchedMovies.length
    ? shuffledWatchedMovies.join(", ")
    : "Chưa có phim nào"
}

11. Không được chọn lại các ứng viên đã bị server loại trong lượt này:
${
  rejectedCandidates.length
    ? rejectedCandidates.join(", ")
    : "Chưa có"
}

12. Nếu yêu cầu chứa "Nhật Bản" hoặc "Japan" nhưng không chứa từ "anime"
hoặc "hoạt hình":
   - Bắt buộc chỉ chọn phim live-action do người thật đóng.
   - Tuyệt đối không chọn anime, hoạt hình hoặc CGI animation.
   - Kết quả phải có diễn viên người thật.

13. Chỉ được chọn anime hoặc hoạt hình Nhật Bản khi người dùng yêu cầu rõ:
   - "anime"
   - "hoạt hình"
   - "hoạt hình Nhật Bản"

14. Nội dung không được spoil kết thúc phim.

15. Nội dung tối đa 3 câu.

16. Lý do đề xuất tối đa 2 câu.

17. Điểm IMDb phải ở định dạng ví dụ "8.5/10".

18. Không được dùng một thứ tự đề xuất cố định. Khi cùng một yêu cầu được gửi lại,
phải thay đổi lựa chọn giữa nhiều thời kỳ, đạo diễn và mức độ nổi tiếng khác nhau,
miễn là vẫn đáp ứng toàn bộ điều kiện.

19. Mã xáo trộn nội bộ của lượt ${attempt} là: ${randomSeed}
Chỉ dùng mã này để đa dạng hóa lựa chọn, không nhắc lại mã trong kết quả.

Yêu cầu của người dùng:
${message.trim()}
`;

      const response = await ai.interactions.create({
        model: "gemini-3.1-flash-lite",
        input: prompt,

        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: movieSchema,
        },
      });

      if (!response.output_text) {
        throw new Error("Gemini không trả về nội dung.");
      }

      const rawJson = response.output_text
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

      const movieData = JSON.parse(rawJson);

      console.log(
        `🎬 Gemini chọn lần ${attempt}: ` +
          `${movieData.ten_quoc_te} (${movieData.nam})`,
      );

      const validationReasons = validateMovieCandidate(
        movieData,
        exclusions,
      );

      if (validationReasons.length) {
        console.warn(
          "🚫 Loại ứng viên:",
          validationReasons,
        );

        rejectedCandidates.push(
          `${movieData.ten_quoc_te} (${movieData.nam})`,
        );

        continue;
      }

      const tmdbData = await getTmdbMovieData(movieData);

      const tmdbValidationReasons =
        await validateTmdbExclusions(
          tmdbData,
          exclusions,
        );

      if (tmdbValidationReasons.length) {
        console.warn(
          "🚫 TMDB loại ứng viên:",
          tmdbValidationReasons,
        );

        rejectedCandidates.push(
          `${movieData.ten_quoc_te} (${movieData.nam})`,
        );

        continue;
      }

      movieData.poster_url =
        tmdbData?.poster_url || null;

      movieData.backdrop_url =
        tmdbData?.backdrop_url || null;

      movieData.tmdb_id = tmdbData?.id || null;

      movieData.tmdb_media_type =
        tmdbData?.media_type || null;

      delete movieData.an_toan_chu_quyen_viet_nam;
      delete movieData.ghi_chu_chu_quyen;

      console.log(
        "📦 Poster gửi về frontend:",
        movieData.poster_url,
      );

      return res.json({
        success: true,
        data: movieData,
      });
    }

    return res.status(422).json({
      success: false,
      error:
        "Không tìm được phim vừa thỏa điều kiện, vừa vượt qua chế độ loại trừ và kiểm tra chủ quyền. Hãy nới bớt điều kiện rồi thử lại.",
    });
  } catch (error) {
    console.error("❌ Lỗi gọi API:", error);

    if (
      error?.status === 429 ||
      error?.statusCode === 429
    ) {
      return res.status(429).json({
        success: false,
        error:
          "Gemini đã hết quota. Hãy chờ quota reset hoặc kiểm tra Billing trong Google AI Studio.",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Không gọi được API.",
      details:
        error?.message || "Lỗi không xác định",
    });
  }
});


app.get(
  "/api/watch-providers/:mediaType/:id",
  async (req, res) => {
    const mediaType = String(
      req.params.mediaType || "",
    ).toLowerCase();

    const tmdbId = Number(req.params.id);

    const requestedRegion = String(
      req.query.region || "VN",
    )
      .trim()
      .toUpperCase();

    const region = /^[A-Z]{2}$/.test(requestedRegion)
      ? requestedRegion
      : "VN";

    if (!["movie", "tv"].includes(mediaType)) {
      return res.status(400).json({
        success: false,
        error: "Loại nội dung TMDB không hợp lệ.",
      });
    }

    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({
        success: false,
        error: "TMDB ID không hợp lệ.",
      });
    }

    try {
      const providerResponse = await fetchTmdbJson(
        `/${mediaType}/${tmdbId}/watch/providers`,
      );

      const regionData =
        providerResponse.results?.[region] || null;

      const normalizeProviders = (providers = []) =>
        providers.map((provider) => ({
          provider_id: provider.provider_id,
          provider_name: provider.provider_name,
          display_priority:
            provider.display_priority ?? 999,
          logo_url: provider.logo_path
            ? `https://image.tmdb.org/t/p/w154${provider.logo_path}`
            : null,
        }));

      const groups = {
        flatrate: normalizeProviders(
          regionData?.flatrate,
        ),
        free: normalizeProviders(regionData?.free),
        ads: normalizeProviders(regionData?.ads),
        rent: normalizeProviders(regionData?.rent),
        buy: normalizeProviders(regionData?.buy),
      };

      const hasProviders = Object.values(groups).some(
        (providers) => providers.length > 0,
      );

      return res.json({
        success: true,
        data: {
          region,
          has_providers: hasProviders,
          link: regionData?.link || null,
          groups,
          search_url: null,
        },
      });
    } catch (error) {
      console.error(
        "❌ Không tải được watch providers:",
        error,
      );

      return res.status(500).json({
        success: false,
        error:
          "Không tải được thông tin nơi xem từ TMDB.",
        details:
          error?.message || "Lỗi không xác định",
      });
    }
  },
);

app.get(
  "/api/movie-details/:mediaType/:id",
  async (req, res) => {
    const mediaType = String(
      req.params.mediaType || "",
    ).toLowerCase();

    const tmdbId = Number(req.params.id);

    if (!["movie", "tv"].includes(mediaType)) {
      return res.status(400).json({
        success: false,
        error: "Loại nội dung TMDB không hợp lệ.",
      });
    }

    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({
        success: false,
        error: "TMDB ID không hợp lệ.",
      });
    }

    try {
      const details = await fetchTmdbJson(
        `/${mediaType}/${tmdbId}`,
        {
          language: "vi-VN",
          append_to_response:
            "credits,videos,external_ids,release_dates,content_ratings",
          include_video_language: "vi,en,null",
        },
      );

      let englishDetails = null;

      if (!details.overview || !details.tagline) {
        try {
          englishDetails = await fetchTmdbJson(
            `/${mediaType}/${tmdbId}`,
            {
              language: "en-US",
            },
          );
        } catch (fallbackError) {
          console.warn(
            "⚠️ Không tải được mô tả tiếng Anh:",
            fallbackError.message,
          );
        }
      }

      const crew = details.credits?.crew || [];

      const directors =
        mediaType === "movie"
          ? crew
              .filter(
                (person) =>
                  person.job === "Director",
              )
              .map((person) => person.name)
          : (details.created_by || []).map(
              (person) => person.name,
            );

      const cast = (details.credits?.cast || [])
        .slice(0, 12)
        .map((person) => ({
          id: person.id,
          name: person.name,
          character: person.character || "",
          profile_url: person.profile_path
            ? `https://image.tmdb.org/t/p/w185${person.profile_path}`
            : null,
        }));

      const videos = details.videos?.results || [];

      const trailer =
        videos.find(
          (video) =>
            video.site === "YouTube" &&
            video.type === "Trailer" &&
            video.official &&
            video.iso_639_1 === "vi",
        ) ||
        videos.find(
          (video) =>
            video.site === "YouTube" &&
            video.type === "Trailer" &&
            video.official,
        ) ||
        videos.find(
          (video) =>
            video.site === "YouTube" &&
            video.type === "Trailer",
        ) ||
        videos.find(
          (video) => video.site === "YouTube",
        );

      let certification = "";

      if (mediaType === "movie") {
        const countryRelease =
          details.release_dates?.results?.find(
            (item) => item.iso_3166_1 === "US",
          ) ||
          details.release_dates?.results?.find(
            (item) => item.iso_3166_1 === "VN",
          );

        certification =
          countryRelease?.release_dates?.find(
            (item) => item.certification,
          )?.certification || "";
      } else {
        const rating =
          details.content_ratings?.results?.find(
            (item) => item.iso_3166_1 === "US",
          ) ||
          details.content_ratings?.results?.find(
            (item) => item.iso_3166_1 === "VN",
          );

        certification = rating?.rating || "";
      }

      const releaseDate =
        details.release_date ||
        details.first_air_date ||
        "";

      const runtime =
        mediaType === "movie"
          ? details.runtime
          : details.episode_run_time?.[0] ||
            details.last_episode_to_air?.runtime ||
            null;

      const title =
        details.title ||
        details.name ||
        details.original_title ||
        details.original_name ||
        "";

      const originalTitle =
        details.original_title ||
        details.original_name ||
        "";

      return res.json({
        success: true,
        data: {
          tmdb_id: details.id,
          media_type: mediaType,
          title,
          vietnamese_title: title,
          original_title: originalTitle,
          tagline:
            details.tagline ||
            englishDetails?.tagline ||
            "",
          overview:
            details.overview ||
            englishDetails?.overview ||
            "",
          poster_url: details.poster_path
            ? `https://image.tmdb.org/t/p/w500${details.poster_path}`
            : null,
          backdrop_url: details.backdrop_path
            ? `https://image.tmdb.org/t/p/original${details.backdrop_path}`
            : null,
          release_date: releaseDate,
          year: releaseDate
            ? Number(releaseDate.slice(0, 4))
            : null,
          runtime,
          status: details.status || "",
          genres: (details.genres || []).map(
            (genre) => genre.name,
          ),
          countries: (
            details.production_countries ||
            details.origin_country ||
            []
          ).map((country) =>
            typeof country === "string"
              ? country
              : country.name,
          ),
          languages: (
            details.spoken_languages || []
          ).map(
            (language) =>
              language.english_name ||
              language.name,
          ),
          directors: [
            ...new Set(directors.filter(Boolean)),
          ],
          cast,
          vote_average: details.vote_average
            ? Number(details.vote_average.toFixed(1))
            : null,
          vote_count: details.vote_count || 0,
          number_of_seasons:
            details.number_of_seasons || null,
          number_of_episodes:
            details.number_of_episodes || null,
          certification,
          trailer_key: trailer?.key || null,
          trailer_name: trailer?.name || null,
          trailer_url: trailer?.key
            ? `https://www.youtube.com/watch?v=${trailer.key}`
            : null,
          imdb_id:
            details.external_ids?.imdb_id || null,
        },
      });
    } catch (error) {
      console.error(
        "❌ Không tải được chi tiết TMDB:",
        error,
      );

      return res.status(500).json({
        success: false,
        error:
          "Không tải được thông tin chi tiết từ TMDB.",
        details:
          error?.message || "Lỗi không xác định",
      });
    }
  },
);

/**
 * Route kiểm tra nhanh TMDB.
 *
 * Mở:
 * http://localhost:3000/api/test-tmdb
 */
app.get("/api/test-tmdb", async (req, res) => {
  try {
    const testMovie = {
      ten_quoc_te: "Parasite",
      ten_viet: "Ký Sinh Trùng",
      ten_goc: "Gisaengchung",
      nam: 2019,
    };

    const tmdbData = await getTmdbMovieData(testMovie);

    if (!tmdbData) {
      return res.status(500).json({
        success: false,
        error: "Không tìm được poster. Kiểm tra TMDB_TOKEN hoặc TMDB_API_KEY.",
      });
    }

    return res.json({
      success: true,
      data: tmdbData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Lỗi TMDB",
    });
  }
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);

  if (TMDB_TOKEN) {
    console.log("✅ Đã nạp TMDB Read Access Token.");
  } else if (TMDB_API_KEY) {
    console.log("✅ Đã nạp TMDB API Key.");
  } else {
    console.log("⚠️ Chưa có thông tin xác thực TMDB.");
  }

  console.log(`🧪 Test TMDB tại http://localhost:${PORT}/api/test-tmdb`);
});
