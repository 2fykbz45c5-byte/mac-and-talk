
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================================
   MAC&TALK — MAIN WEBSITE SCRIPT
========================================= */

const SUPABASE_URL = "https://gprdmwjqgyrvqrgjkycc.supabase.co";
const SUPABASE_KEY = "sb_publishable_uBlQa2v-VS9OYVRk3FEE4A_CwmVPVH4";

// IMPORTANT: This must exactly match your Supabase Storage bucket name.
const AUDIO_BUCKET = "podcasts";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (selector) => document.querySelector(selector);

let allEpisodes = [];
let refreshInProgress = false;

/* =========================================
   GENERAL HELPERS
========================================= */

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function niceDate(value) {
  if (!value) return "Date to be announced";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date to be announced";
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function getElement(id) {
  return document.getElementById(id);
}

function setMessage(id, message) {
  const element = getElement(id);
  if (element) element.textContent = message;
}

function showElement(id, show) {
  const element = getElement(id);
  if (element) element.hidden = !show;
}

function escapeAttribute(value) {
  return safe(value);
}

/* =========================================
   PODCAST CATEGORY
   Your current database schema does not
   contain a category column, so categories
   are inferred from the episode information.
========================================= */

function inferCategory(episode) {
  const text = [
    episode.title,
    episode.description,
    episode.host_name
  ].join(" ").toLowerCase();

  if (
    /\b(technology|tech|computer|ai|artificial intelligence|internet|digital)\b/.test(text)
  ) {
    return "technology";
  }

  if (
    /\b(school|student|teacher|class|education|study|exam|math|science|learning)\b/.test(text)
  ) {
    return "school";
  }

  return "everyday";
}

function categoryLabel(category) {
  const labels = {
    everyday: "Everyday Life",
    school: "School",
    technology: "Technology"
  };

  return labels[category] || "Everyday Life";
}

/* =========================================
   AUDIO URL RESOLUTION

   Storage paths should look like:
   user-id/file-name.webm

   Do not include the bucket name at
   the beginning of audio_path.
========================================= */

function cleanStoragePath(path) {
  let result = String(path || "").trim();

  if (!result) return "";

  // If a full URL was stored in audio_path,
  // use it directly instead.
  if (validHttpUrl(result)) return result;

  result = result.replace(/^\/+/, "");

  // Remove an accidentally duplicated bucket prefix.
  const bucketPrefix = `${AUDIO_BUCKET}/`;

  if (result.startsWith(bucketPrefix)) {
    result = result.slice(bucketPrefix.length);
  }

  return result;
}

async function resolveAudioUrl(episode) {
  const rawPath = cleanStoragePath(episode.audio_path);

  // A full URL in audio_path is already usable.
  if (validHttpUrl(rawPath)) {
    return rawPath;
  }

  // Prefer a signed URL. This also works with a private
  // bucket if the signed URL request is permitted.
  if (rawPath) {
    try {
      const { data, error } = await supabase.storage
        .from(AUDIO_BUCKET)
        .createSignedUrl(rawPath, 3600);

      if (!error && data?.signedUrl && validHttpUrl(data.signedUrl)) {
        return data.signedUrl;
      }

      if (error) {
        console.warn(
          "Could not create a signed audio URL:",
          error.message
        );
      }
    } catch (error) {
      console.warn("Signed audio URL request failed:", error);
    }

    // Try the public URL as a fallback. This only works
    // when the bucket is public and the object is accessible.
    try {
      const { data } = supabase.storage
        .from(AUDIO_BUCKET)
        .getPublicUrl(rawPath);

      if (data?.publicUrl && validHttpUrl(data.publicUrl)) {
        return data.publicUrl;
      }
    } catch (error) {
      console.warn("Could not create a public audio URL:", error);
    }
  }

  // Last fallback: an already-saved absolute URL.
  if (validHttpUrl(episode.audio_url)) {
    return episode.audio_url;
  }

  return "";
}

/* =========================================
   PODCAST CARD
========================================= */

function podcastCard(episode) {
  const category = inferCategory(episode);
  const audioUrl = episode.resolvedAudioUrl || "";
  const host = episode.host_name || "Mac&Talk Creator";
  const type = episode.episode_type || "podcast";

  const coverEmoji = type === "live_replay" ? "🔴" : "🎙️";
  const coverLabel = type === "live_replay"
    ? "Live Replay"
    : categoryLabel(category);

  const audioSection = audioUrl
    ? `
      <div class="episode-audio">
        <audio
          class="podcast-audio"
          controls
          preload="metadata"
          playsinline
          src="${escapeAttribute(audioUrl)}"
          aria-label="Listen to ${safe(episode.title)}"
        ></audio>
        <p class="audio-status" aria-live="polite">
          Loading audio…
        </p>
      </div>
    `
    : `
      <p class="audio-status audio-error" role="status">
        Audio unavailable. Check the Storage bucket and file path.
      </p>
    `;

  return `
    <article
      class="podcast-card"
      data-category="${safe(category)}"
      data-search="${safe([
        episode.title,
        episode.description,
        host,
        categoryLabel(category),
        type
      ].join(" ").toLowerCase())}"
    >
      <div class="podcast-cover">
        <span class="podcast-cover-emoji" aria-hidden="true">
          ${coverEmoji}
        </span>
        <span class="podcast-category">
          ${safe(coverLabel)}
        </span>
      </div>

      <div class="podcast-content">
        <p class="podcast-host">Hosted by ${safe(host)}</p>

        <h3 class="podcast-title">
          ${safe(episode.title || "Untitled episode")}
        </h3>

        <p class="podcast-description">
          ${safe(episode.description || "Listen to this Mac&Talk episode.")}
        </p>

        ${audioSection}

        <p class="podcast-date">
          ${safe(niceDate(episode.created_at))}
        </p>
      </div>
    </article>
  `;
}

/* =========================================
   PODCAST SEARCH AND CATEGORY FILTER
========================================= */

function filterPodcasts() {
  const grid = getElement("podcastGrid");
  if (!grid) return;

  const searchInput = getElement("searchInput");
  const categoryFilter = getElement("categoryFilter");

  const query = (searchInput?.value || "").trim().toLowerCase();
  const selectedCategory = categoryFilter?.value || "all";

  const cards = grid.querySelectorAll(".podcast-card");
  let visibleCount = 0;

  cards.forEach((card) => {
    const searchText = card.dataset.search || "";
    const category = card.dataset.category || "everyday";

    const matchesSearch = !query || searchText.includes(query);
    const matchesCategory =
      selectedCategory === "all" ||
      selectedCategory === category;

    const visible = matchesSearch && matchesCategory;

    card.hidden = !visible;

    if (visible) visibleCount++;
  });

  const noPodcasts = getElement("noPodcasts");

  if (noPodcasts) {
    noPodcasts.hidden = visibleCount !== 0;

    if (visibleCount === 0) {
      noPodcasts.textContent = allEpisodes.length
        ? "No episodes match your search. Try another keyword or category."
        : "No published podcasts are available yet.";
    }
  }
}

function setupPodcastSearch() {
  getElement("searchInput")?.addEventListener(
    "input",
    filterPodcasts
  );

  getElement("categoryFilter")?.addEventListener(
    "change",
    filterPodcasts
  );
}

/* =========================================
   AUDIO PLAYER STATUS
========================================= */

function setupAudioPlayers() {
  document.querySelectorAll(".podcast-audio").forEach((audio) => {
    const card = audio.closest(".podcast-card");
    const status = card?.querySelector(".audio-status");

    if (!status) return;

    audio.addEventListener("loadedmetadata", () => {
      status.textContent = "";

      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const minutes = Math.floor(audio.duration / 60);
        const seconds = Math.floor(audio.duration % 60)
          .toString()
          .padStart(2, "0");

        status.textContent = `Duration: ${minutes}:${seconds}`;
      } else {
        status.textContent = "Audio loaded.";
      }
    });

    audio.addEventListener("canplay", () => {
      status.textContent = "Ready to play.";
      status.classList.remove("audio-error");
    });

    audio.addEventListener("error", () => {
      const code = audio.error?.code;

      const messages = {
        1: "Audio loading was interrupted. Try again.",
        2: "Network error while loading audio.",
        3: "The audio file could not be decoded. The format or codec may be unsupported.",
        4: "Audio source unavailable. Check the file URL, Storage permissions, and file format."
      };

      status.textContent = messages[code] ||
        "Unable to load audio. Check the file URL and format.";

      status.classList.add("audio-error");

      console.error("Podcast audio error:", {
        title: card?.querySelector(".podcast-title")?.textContent,
        source: audio.currentSrc,
        errorCode: code,
        errorMessage: audio.error?.message
      });
    });

    audio.addEventListener("playing", () => {
      status.textContent = "Playing";
    });

    audio.addEventListener("pause", () => {
      if (!audio.ended && !audio.error) {
        status.textContent = audio.currentTime > 0
          ? "Paused"
          : "Ready to play.";
      }
    });

    audio.addEventListener("ended", () => {
      status.textContent = "Episode finished.";
    });
  });
}

/* =========================================
   LOAD PUBLISHED PODCASTS FROM SUPABASE
========================================= */

async function loadPodcasts() {
  const grid = getElement("podcastGrid");

  if (!grid) {
    console.warn("Element #podcastGrid was not found.");
    return;
  }

  setMessage("noPodcasts", "Loading podcasts…");

  try {
    const { data, error } = await supabase
      .from("podcast_episodes")
      .select(`
        id,
        host_user_id,
        host_name,
        title,
        description,
        audio_path,
        audio_url,
        published,
        created_at,
        episode_type
      `)
      .eq("published", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    allEpisodes = data || [];

    if (allEpisodes.length === 0) {
      grid.innerHTML = "";
      showElement("noPodcasts", true);
      setMessage("noPodcasts", "No published podcasts are available yet.");
      return;
    }

    // Resolve audio URLs without stopping other episodes
    // from displaying if one file has a problem.
    allEpisodes = await Promise.all(
      allEpisodes.map(async (episode) => {
        try {
          const resolvedAudioUrl = await resolveAudioUrl(episode);
          return { ...episode, resolvedAudioUrl };
        } catch (error) {
          console.error(
            "Could not resolve audio for:",
            episode.title,
            error
          );

          return { ...episode, resolvedAudioUrl: "" };
        }
      })
    );

    grid.innerHTML = allEpisodes.map(podcastCard).join("");

    setupAudioPlayers();
    filterPodcasts();

  } catch (error) {
    console.error("Could not load Mac&Talk podcasts:", error);

    grid.innerHTML = "";

    showElement("noPodcasts", true);
    setMessage(
      "noPodcasts",
      "Could not load podcasts. Check your Supabase connection, table permissions, and browser console."
    );
  }
}

/* =========================================
   LIVE AND UPCOMING BROADCAST CARDS
========================================= */

function cover(session) {
  if (validHttpUrl(session.cover_image_url || "")) {
    return `
      <img
        class="session-cover-image"
        src="${escapeAttribute(session.cover_image_url)}"
        alt=""
        loading="lazy"
      >
    `;
  }

  return `<span class="session-cover-emoji" aria-hidden="true">🎙️</span>`;
}

function liveCard(session) {
  const joinUrl = validHttpUrl(session.join_url || "")
    ? session.join_url
    : "";

  return `
    <article class="live-card">
      <div class="session-cover">
        ${cover(session)}
        <span class="live-badge">LIVE</span>
      </div>

      <div class="session-content">
        <h3>${safe(session.title || "Live broadcast")}</h3>

        <p>${safe(session.description || "Join the conversation on Mac&Talk.")}</p>

        <p class="session-date">Live now</p>

        ${
          joinUrl
            ? `<a class="session-button" href="${escapeAttribute(joinUrl)}" target="_blank" rel="noopener noreferrer">Join Live</a>`
            : `<p class="session-note">The listening link is not available yet.</p>`
        }
      </div>
    </article>
  `;
}

function upcomingCard(session) {
  const joinUrl = validHttpUrl(session.join_url || "")
    ? session.join_url
    : "";

  return `
    <article class="upcoming-card">
      <div class="session-cover">
        ${cover(session)}
        <span class="upcoming-badge">UPCOMING</span>
      </div>

      <div class="session-content">
        <h3>${safe(session.title || "Upcoming broadcast")}</h3>

        <p>${safe(session.description || "A new Mac&Talk broadcast is coming soon.")}</p>

        <p class="session-date">
          ${safe(niceDate(session.scheduled_at))}
        </p>

        ${
          joinUrl
            ? `<a class="session-button" href="${escapeAttribute(joinUrl)}" target="_blank" rel="noopener noreferrer">Open Session</a>`
            : `<p class="session-note">The session link will be available when provided by the administrator.</p>`
        }
      </div>
    </article>
  `;
}

function showEmptyStates(liveCount, upcomingCount) {
  showElement("noLive", liveCount === 0);
  showElement("noUpcoming", upcomingCount === 0);

  if (liveCount === 0) {
    setMessage("noLive", "There are no live broadcasts right now.");
  }

  if (upcomingCount === 0) {
    setMessage("noUpcoming", "There are no upcoming broadcasts yet.");
  }
}

/* =========================================
   LOAD LIVE SESSIONS FROM SUPABASE
========================================= */

async function loadLiveSessions() {
  const liveGrid = getElement("liveGrid");
  const upcomingGrid = getElement("upcomingGrid");

  if (!liveGrid || !upcomingGrid) return;

  try {
    const { data, error } = await supabase
      .from("live_sessions")
      .select(`
        id,
        title,
        description,
        scheduled_at,
        join_url,
        cover_image_url,
        status,
        approved,
        created_at
      `)
      .eq("approved", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const sessions = data || [];
    const now = Date.now();

    const liveSessions = sessions.filter(
      (session) => session.status === "live"
    );

    const upcomingSessions = sessions.filter((session) => {
      if (session.status !== "scheduled") return false;

      // Keep scheduled sessions without a date visible.
      if (!session.scheduled_at) return true;

      const scheduledTime = new Date(session.scheduled_at).getTime();

      return Number.isFinite(scheduledTime) && scheduledTime >= now;
    });

    liveGrid.innerHTML = liveSessions.map(liveCard).join("");
    upcomingGrid.innerHTML = upcomingSessions.map(upcomingCard).join("");

    showEmptyStates(liveSessions.length, upcomingSessions.length);

    setMessage("liveMessage", "");

  } catch (error) {
    console.error("Could not load live sessions:", error);

    setMessage(
      "liveMessage",
      "Live broadcasts could not be loaded. Check the live_sessions table permissions."
    );

    liveGrid.innerHTML = "";
    upcomingGrid.innerHTML = "";

    showEmptyStates(0, 0);
  }
}

/* =========================================
   MOBILE NAVIGATION
========================================= */

function setupNavigation() {
  const menuToggle = getElement("menuToggle");
  const navLinks = getElement("navLinks");

  if (!menuToggle || !navLinks) return;

  menuToggle.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("active");

    menuToggle.setAttribute("aria-expanded", String(isOpen));
    menuToggle.setAttribute(
      "aria-label",
      isOpen ? "Close navigation menu" : "Open navigation menu"
    );
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("active");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open navigation menu");
    });
  });
}

/* =========================================
   INITIALIZE WEBSITE
========================================= */

async function initialize() {
  const year = getElement("currentYear");

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  setupNavigation();
  setupPodcastSearch();

  await Promise.all([
    loadPodcasts(),
    loadLiveSessions()
  ]);
}

initialize();

// Refresh live/upcoming sessions every 30 seconds.
// Do not reload the audio player on every refresh.
setInterval(async () => {
  if (refreshInProgress) return;

  refreshInProgress = true;

  try {
    await loadLiveSessions();
  } finally {
    refreshInProgress = false;
  }
}, 30000);
