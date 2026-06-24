(() => {
  "use strict";

  const CONFIG_ENDPOINT = "/api/supabase-config";
  const TABLE_NAME = "movie_gacha_user_data";
  const SYNC_META_KEY = "movieGachaSyncMeta";
  const LAST_SYNC_USER_KEY = "movieGachaLastSyncUser";
  const SYNC_INTERVAL_MS = 60_000;
  const PUSH_DEBOUNCE_MS = 900;

  const DATASETS = {
    history: {
      storageKey: "randomMovieHistory",
      cloudKey: "history",
      kind: "movies",
      limit: 8,
    },
    seen: {
      storageKey: "randomMovieSeen",
      cloudKey: "seen_movies",
      kind: "strings",
      limit: 500,
    },
    watched: {
      storageKey: "watchedMovies",
      cloudKey: "watched_movies",
      kind: "movies",
      limit: 1000,
    },
    saved: {
      storageKey: "savedRandomMovies",
      cloudKey: "saved_movies",
      kind: "movies",
      limit: 500,
    },
    advancedFilters: {
      storageKey: "movieGachaAdvancedFilters",
      cloudKey: "advanced_filters",
      kind: "object",
    },
    exclusionMode: {
      storageKey: "movieGachaExclusionMode",
      cloudKey: "exclusion_mode",
      kind: "object",
    },
  };

  const STORAGE_TO_DATASET = Object.fromEntries(
    Object.entries(DATASETS).map(([name, config]) => [
      config.storageKey,
      name,
    ]),
  );

  const refs = {
    accountButton: document.getElementById("account-button"),
    accountAvatar: document.getElementById("account-avatar"),
    accountLabel: document.getElementById("account-label"),
    accountSubtitle: document.getElementById("account-subtitle"),
    syncNowButton: document.getElementById("sync-now-button"),
    syncStatus: document.getElementById("sync-status"),
    authModal: document.getElementById("auth-modal"),
    authCloseButton: document.getElementById("auth-close-button"),
    loggedOutView: document.getElementById("auth-logged-out-view"),
    loggedInView: document.getElementById("auth-logged-in-view"),
    setupWarning: document.getElementById("auth-setup-warning"),
    loginTab: document.getElementById("auth-login-tab"),
    signupTab: document.getElementById("auth-signup-tab"),
    authForm: document.getElementById("auth-form"),
    email: document.getElementById("auth-email"),
    password: document.getElementById("auth-password"),
    submitButton: document.getElementById("auth-submit-button"),
    googleButton: document.getElementById("google-login-button"),
    authDivider: document.getElementById("auth-divider"),
    authMessage: document.getElementById("auth-message"),
    userAvatar: document.getElementById("auth-user-avatar"),
    userEmail: document.getElementById("auth-user-email"),
    userIdShort: document.getElementById("auth-user-id-short"),
    watchedTotal: document.getElementById("auth-watched-total"),
    savedTotal: document.getElementById("auth-saved-total"),
    seenTotal: document.getElementById("auth-seen-total"),
    authSyncButton: document.getElementById("auth-sync-button"),
    logoutButton: document.getElementById("auth-logout-button"),
  };

  let client = null;
  let session = null;
  let configured = false;
  let authMode = "login";
  let syncTimer = null;
  let syncInterval = null;
  let syncPromise = null;
  let syncAgain = false;
  let applyingCloudData = false;
  let authReturnFocus = null;
  let handledUserId = null;

  function safeJsonParse(value, fallback) {
    try {
      const parsed = JSON.parse(value);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function readLocalMeta() {
    const meta = safeJsonParse(
      localStorage.getItem(SYNC_META_KEY),
      {},
    );

    return meta && typeof meta === "object" && !Array.isArray(meta)
      ? meta
      : {};
  }

  function writeLocalMeta(meta) {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta || {}));
  }

  function markDatasetUpdated(datasetName) {
    const meta = readLocalMeta();
    meta[datasetName] = new Date().toISOString();
    writeLocalMeta(meta);
  }

  function parseTimestamp(value) {
    if (!value) return 0;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function movieId(movie) {
    const source =
      movie?.tmdb_id ||
      movie?.ten_quoc_te ||
      movie?.ten_goc ||
      movie?.ten_viet ||
      "";

    return `${source}-${movie?.nam ?? ""}`.trim().toLowerCase();
  }

  function mergeMovieArrays(primary, secondary, limit) {
    const result = [];
    const ids = new Set();

    [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]
      .forEach((movie) => {
        if (!movie || typeof movie !== "object") return;
        const id = movieId(movie);
        if (!id || ids.has(id)) return;
        ids.add(id);
        result.push(movie);
      });

    return result.slice(0, limit);
  }

  function mergeStringArrays(primary, secondary, limit) {
    const result = [];
    const values = new Set();

    [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]
      .forEach((item) => {
        const clean = String(item || "").trim();
        const normalized = clean.toLowerCase();
        if (!clean || values.has(normalized)) return;
        values.add(normalized);
        result.push(clean);
      });

    return result.slice(0, limit);
  }

  function isMeaningfulObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    return Object.values(value).some((item) => {
      if (Array.isArray(item)) return item.length > 0;
      if (typeof item === "boolean") return item === false;
      return String(item ?? "").trim() !== "";
    });
  }

  function isMeaningfulDataset(value, kind) {
    if (kind === "object") return isMeaningfulObject(value);
    return Array.isArray(value) && value.length > 0;
  }

  function normalizeDataset(value, config) {
    if (config.kind === "movies") {
      return mergeMovieArrays(value, [], config.limit);
    }

    if (config.kind === "strings") {
      return mergeStringArrays(value, [], config.limit);
    }

    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function readLocalDataset(config) {
    const fallback = config.kind === "object" ? {} : [];
    return normalizeDataset(
      safeJsonParse(localStorage.getItem(config.storageKey), fallback),
      config,
    );
  }

  function readLocalSnapshot() {
    const snapshot = {};

    Object.entries(DATASETS).forEach(([name, config]) => {
      snapshot[name] = readLocalDataset(config);
    });

    return snapshot;
  }

  function cloudRowToSnapshot(row) {
    const snapshot = {};

    Object.entries(DATASETS).forEach(([name, config]) => {
      snapshot[name] = normalizeDataset(row?.[config.cloudKey], config);
    });

    return snapshot;
  }

  function snapshotsEqual(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
  }

  function mergeDataset(name, localValue, cloudValue, localMeta, cloudMeta) {
    const config = DATASETS[name];
    const localTime = parseTimestamp(localMeta?.[name]);
    const cloudTime = parseTimestamp(cloudMeta?.[name]);

    if (localTime && cloudTime && localTime !== cloudTime) {
      return localTime > cloudTime
        ? { value: localValue, timestamp: localMeta[name] }
        : { value: cloudValue, timestamp: cloudMeta[name] };
    }

    if (localTime && !cloudTime) {
      return { value: localValue, timestamp: localMeta[name] };
    }

    if (!localTime && cloudTime) {
      const localHasData = isMeaningfulDataset(localValue, config.kind);
      const cloudHasData = isMeaningfulDataset(cloudValue, config.kind);

      if (localHasData && cloudHasData && config.kind !== "object") {
        const merged = config.kind === "movies"
          ? mergeMovieArrays(cloudValue, localValue, config.limit)
          : mergeStringArrays(cloudValue, localValue, config.limit);

        return {
          value: merged,
          timestamp: new Date().toISOString(),
        };
      }

      return cloudHasData || !localHasData
        ? { value: cloudValue, timestamp: cloudMeta[name] }
        : { value: localValue, timestamp: new Date().toISOString() };
    }

    if (config.kind === "movies") {
      return {
        value: mergeMovieArrays(localValue, cloudValue, config.limit),
        timestamp: new Date().toISOString(),
      };
    }

    if (config.kind === "strings") {
      return {
        value: mergeStringArrays(localValue, cloudValue, config.limit),
        timestamp: new Date().toISOString(),
      };
    }

    const cloudHasData = isMeaningfulDataset(cloudValue, config.kind);
    const localHasData = isMeaningfulDataset(localValue, config.kind);

    return {
      value: cloudHasData ? cloudValue : localValue,
      timestamp: cloudHasData || localHasData
        ? new Date().toISOString()
        : null,
    };
  }

  function mergeSnapshots(localSnapshot, cloudSnapshot, localMeta, cloudMeta) {
    const snapshot = {};
    const meta = {};

    Object.keys(DATASETS).forEach((name) => {
      const result = mergeDataset(
        name,
        localSnapshot[name],
        cloudSnapshot[name],
        localMeta,
        cloudMeta,
      );

      snapshot[name] = result.value;
      if (result.timestamp) meta[name] = result.timestamp;
    });

    return { snapshot, meta };
  }

  function createFreshMeta(snapshot) {
    const now = new Date().toISOString();
    const meta = {};

    Object.entries(DATASETS).forEach(([name, config]) => {
      if (isMeaningfulDataset(snapshot[name], config.kind)) {
        meta[name] = now;
      }
    });

    return meta;
  }

  function buildCloudPayload(userId, snapshot, meta) {
    const payload = {
      user_id: userId,
      sync_meta: meta || {},
      updated_at: new Date().toISOString(),
    };

    Object.entries(DATASETS).forEach(([name, config]) => {
      payload[config.cloudKey] = snapshot[name];
    });

    return payload;
  }

  function applyLocalSnapshot(snapshot, meta) {
    applyingCloudData = true;

    try {
      Object.entries(DATASETS).forEach(([name, config]) => {
        localStorage.setItem(
          config.storageKey,
          JSON.stringify(snapshot[name]),
        );
      });

      writeLocalMeta(meta);

      if (typeof loadAdvancedFilters === "function") {
        loadAdvancedFilters();
      }

      if (typeof loadExclusionMode === "function") {
        loadExclusionMode();
      }

      if (typeof renderHistory === "function") renderHistory();
      if (typeof renderWatchedMovies === "function") renderWatchedMovies();
      if (typeof renderSavedMovies === "function") renderSavedMovies();
      if (typeof updateWatchedButtons === "function") updateWatchedButtons();
      if (typeof updateSaveButton === "function") updateSaveButton();
    } finally {
      applyingCloudData = false;
    }

    updateAccountTotals();
  }

  function updateAccountTotals() {
    const snapshot = readLocalSnapshot();
    refs.watchedTotal.textContent = snapshot.watched.length;
    refs.savedTotal.textContent = snapshot.saved.length;
    refs.seenTotal.textContent = snapshot.seen.length;
  }

  function setSyncStatus(text, state = "guest") {
    refs.syncStatus.textContent = text;
    refs.syncStatus.className = `sync-status sync-status-${state}`;
  }

  function formatSyncTime() {
    return new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  }

  function setAuthMessage(message, type = "") {
    refs.authMessage.textContent = message || "";
    refs.authMessage.className = `auth-message${type ? ` auth-message-${type}` : ""}`;
  }

  function setAuthBusy(busy) {
    refs.submitButton.disabled = busy || !configured;
    refs.googleButton.disabled = busy || !configured;
    refs.submitButton.classList.toggle("loading", busy);
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "login";
    const signup = authMode === "signup";

    refs.loginTab.classList.toggle("active", !signup);
    refs.signupTab.classList.toggle("active", signup);
    refs.loginTab.setAttribute("aria-selected", String(!signup));
    refs.signupTab.setAttribute("aria-selected", String(signup));
    refs.submitButton.textContent = signup ? "Tạo tài khoản" : "Đăng nhập";
    refs.password.autocomplete = signup ? "new-password" : "current-password";
    setAuthMessage("");
  }

  function openAuthModal() {
    authReturnFocus = document.activeElement;
    refs.authModal.classList.remove("hidden");
    refs.authModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("auth-modal-open");

    window.setTimeout(() => {
      if (session) {
        refs.authSyncButton.focus();
      } else if (configured) {
        refs.email.focus();
      } else {
        refs.authCloseButton.focus();
      }
    }, 30);
  }

  function closeAuthModal() {
    refs.authModal.classList.add("hidden");
    refs.authModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("auth-modal-open");

    if (authReturnFocus) authReturnFocus.focus();
  }

  function userInitial(user) {
    const name =
      user?.user_metadata?.full_name ||
      user?.user_metadata?.name ||
      user?.email ||
      "M";

    return String(name).trim().charAt(0).toUpperCase() || "M";
  }

  function updateAuthUI() {
    const user = session?.user || null;

    refs.loggedOutView.classList.toggle("hidden", Boolean(user));
    refs.loggedInView.classList.toggle("hidden", !user);
    refs.syncNowButton.classList.toggle("hidden", !user);

    if (!user) {
      refs.accountAvatar.textContent = "👤";
      refs.accountLabel.textContent = configured ? "Đăng nhập" : "Thiết lập đồng bộ";
      refs.accountSubtitle.textContent = configured
        ? "Đồng bộ nhiều thiết bị"
        : "Chưa cấu hình Supabase";
      setSyncStatus(
        configured ? "Chỉ lưu trên thiết bị" : "Đồng bộ chưa cấu hình",
        configured ? "guest" : "error",
      );
      return;
    }

    const initial = userInitial(user);
    refs.accountAvatar.textContent = initial;
    refs.accountLabel.textContent = user.email || "Tài khoản Movie Gacha";
    refs.accountSubtitle.textContent = "Đồng bộ đang bật";
    refs.userAvatar.textContent = initial;
    refs.userEmail.textContent = user.email || "Không có email";
    refs.userIdShort.textContent = `ID ${user.id.slice(0, 8)}…`;
    updateAccountTotals();
  }

  async function upsertCloudSnapshot(userId, snapshot, meta) {
    const { error } = await client
      .from(TABLE_NAME)
      .upsert(buildCloudPayload(userId, snapshot, meta), {
        onConflict: "user_id",
      });

    if (error) throw error;
  }

  async function syncWithCloud(options = {}) {
    if (!configured || !client || !session?.user) return;

    if (syncPromise) {
      syncAgain = true;
      return syncPromise;
    }

    syncPromise = (async () => {
      setSyncStatus("Đang đồng bộ…", "syncing");
      refs.syncNowButton.classList.add("spinning");

      const userId = session.user.id;
      const previousUserId = localStorage.getItem(LAST_SYNC_USER_KEY);
      const accountSwitch = Boolean(
        previousUserId && previousUserId !== userId,
      );

      const { data: cloudRow, error } = await client
        .from(TABLE_NAME)
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;

      let localSnapshot = readLocalSnapshot();
      let localMeta = readLocalMeta();

      if (accountSwitch) {
        localSnapshot = Object.fromEntries(
          Object.entries(DATASETS).map(([name, config]) => [
            name,
            config.kind === "object" ? {} : [],
          ]),
        );
        localMeta = {};
      }

      let mergedSnapshot;
      let mergedMeta;

      if (!cloudRow) {
        mergedSnapshot = localSnapshot;
        mergedMeta = createFreshMeta(mergedSnapshot);
      } else {
        const cloudSnapshot = cloudRowToSnapshot(cloudRow);
        const cloudMeta =
          cloudRow.sync_meta && typeof cloudRow.sync_meta === "object"
            ? cloudRow.sync_meta
            : {};

        const merged = mergeSnapshots(
          localSnapshot,
          cloudSnapshot,
          localMeta,
          cloudMeta,
        );

        mergedSnapshot = merged.snapshot;
        mergedMeta = merged.meta;
      }

      applyLocalSnapshot(mergedSnapshot, mergedMeta);
      await upsertCloudSnapshot(userId, mergedSnapshot, mergedMeta);

      localStorage.setItem(LAST_SYNC_USER_KEY, userId);
      setSyncStatus(`Đã đồng bộ lúc ${formatSyncTime()}`, "synced");

      if (options.manual && typeof showToast === "function") {
        showToast("Đồng bộ hoàn tất", "☁️");
      }
    })()
      .catch((error) => {
        console.error("Lỗi đồng bộ Supabase:", error);

        const isMissingTable =
          error?.code === "42P01" ||
          String(error?.message || "").includes(TABLE_NAME);

        setSyncStatus(
          isMissingTable
            ? "Chưa chạy file SQL Supabase"
            : "Đồng bộ thất bại",
          "error",
        );

        if (options.manual && typeof showToast === "function") {
          showToast(
            isMissingTable
              ? "Hãy chạy supabase-schema.sql"
              : error?.message || "Không đồng bộ được",
            "⚠️",
          );
        }
      })
      .finally(() => {
        refs.syncNowButton.classList.remove("spinning");
        syncPromise = null;

        if (syncAgain) {
          syncAgain = false;
          syncWithCloud();
        }
      });

    return syncPromise;
  }

  function scheduleCloudSync() {
    if (!session?.user || !configured) return;

    clearTimeout(syncTimer);
    setSyncStatus("Có thay đổi chưa đồng bộ", "pending");

    syncTimer = window.setTimeout(() => {
      syncWithCloud();
    }, PUSH_DEBOUNCE_MS);
  }

  function trackStorageChange(storageKey) {
    if (applyingCloudData) return;

    const datasetName = STORAGE_TO_DATASET[storageKey];
    if (!datasetName) return;

    markDatasetUpdated(datasetName);
    updateAccountTotals();
    scheduleCloudSync();
  }

  async function handleSession(nextSession, event = "INITIAL_SESSION") {
    session = nextSession || null;
    updateAuthUI();

    if (!session?.user) {
      handledUserId = null;
      return;
    }

    const userId = session.user.id;
    const shouldSync =
      handledUserId !== userId ||
      ["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(event);

    handledUserId = userId;

    if (shouldSync) {
      await syncWithCloud();
    }
  }

  async function submitAuth(event) {
    event.preventDefault();

    if (!configured || !client) {
      setAuthMessage("Chưa cấu hình Supabase trong .env.", "error");
      return;
    }

    const email = refs.email.value.trim();
    const password = refs.password.value;

    if (!email || password.length < 6) {
      setAuthMessage("Nhập email và mật khẩu tối thiểu 6 ký tự.", "error");
      return;
    }

    setAuthBusy(true);
    setAuthMessage("");

    try {
      if (authMode === "signup") {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
          },
        });

        if (error) throw error;

        if (!data.session) {
          setAuthMessage(
            "Đã tạo tài khoản. Kiểm tra email để xác nhận rồi đăng nhập.",
            "success",
          );
          return;
        }

        setAuthMessage("Tạo tài khoản thành công.", "success");
      } else {
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;
      }
    } catch (error) {
      setAuthMessage(error?.message || "Không thể đăng nhập.", "error");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signInWithGoogle() {
    if (!configured || !client) return;

    setAuthBusy(true);
    setAuthMessage("");

    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      setAuthMessage(error.message, "error");
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!client) return;

    refs.logoutButton.disabled = true;

    const { error } = await client.auth.signOut();

    refs.logoutButton.disabled = false;

    if (error) {
      if (typeof showToast === "function") {
        showToast(error.message, "⚠️");
      }
      return;
    }

    closeAuthModal();

    if (typeof showToast === "function") {
      showToast("Đã đăng xuất · dữ liệu vẫn còn trên máy", "👋");
    }
  }

  function bindEvents() {
    refs.accountButton.addEventListener("click", openAuthModal);
    refs.syncNowButton.addEventListener("click", () => {
      syncWithCloud({ manual: true });
    });
    refs.authSyncButton.addEventListener("click", () => {
      syncWithCloud({ manual: true });
    });
    refs.authCloseButton.addEventListener("click", closeAuthModal);
    refs.authModal
      .querySelectorAll("[data-auth-close]")
      .forEach((element) => {
        element.addEventListener("click", closeAuthModal);
      });
    refs.loginTab.addEventListener("click", () => setAuthMode("login"));
    refs.signupTab.addEventListener("click", () => setAuthMode("signup"));
    refs.authForm.addEventListener("submit", submitAuth);
    refs.googleButton.addEventListener("click", signInWithGoogle);
    refs.logoutButton.addEventListener("click", signOut);

    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !refs.authModal.classList.contains("hidden")
      ) {
        closeAuthModal();
      }
    });

    window.addEventListener("focus", () => {
      if (session?.user) syncWithCloud();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && session?.user) {
        syncWithCloud();
      }
    });
  }

  async function initialize() {
    bindEvents();
    setAuthMode("login");
    updateAccountTotals();

    window.movieGachaSync = {
      trackStorageChange,
      syncNow: () => syncWithCloud({ manual: true }),
      getSession: () => session,
    };

    try {
      const response = await fetch(CONFIG_ENDPOINT, {
        cache: "no-store",
      });
      const config = await response.json();

      configured = Boolean(
        config.configured &&
        config.url &&
        config.publishableKey,
      );

      refs.setupWarning.classList.toggle("hidden", configured);
      refs.googleButton.classList.toggle(
        "hidden",
        !configured || !config.googleEnabled,
      );
      refs.authDivider.classList.toggle(
        "hidden",
        !configured || !config.googleEnabled,
      );
      setAuthBusy(false);

      if (!configured) {
        updateAuthUI();
        return;
      }

      if (!window.supabase?.createClient) {
        throw new Error("Không tải được thư viện Supabase JS.");
      }

      client = window.supabase.createClient(
        config.url,
        config.publishableKey,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        },
      );

      const { data, error } = await client.auth.getSession();
      if (error) throw error;

      await handleSession(data.session, "INITIAL_SESSION");

      client.auth.onAuthStateChange((event, nextSession) => {
        window.setTimeout(() => {
          handleSession(nextSession, event);
        }, 0);
      });

      syncInterval = window.setInterval(() => {
        if (session?.user && document.visibilityState === "visible") {
          syncWithCloud();
        }
      }, SYNC_INTERVAL_MS);
    } catch (error) {
      console.error("Không khởi tạo được Supabase:", error);
      configured = false;
      refs.setupWarning.classList.remove("hidden");
      setAuthMessage(error.message, "error");
      updateAuthUI();
    }
  }

  initialize();
})();
