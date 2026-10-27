
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================================
   MAC&TALK — MAIN WEBSITE SCRIPT
   Podcasts + Audio + Live + Upcoming
========================================= */

const SUPABASE_URL =
  "https://gprdmwjqgyrvqrgjkycc.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_uBlQa2v-VS9OYVRk3FEE4A_CwmVPVH4";

const AUDIO_BUCKET = "podcasts";
const LIVE_REFRESH_MS = 30000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);

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
    const url = new URL(String(value || "").trim());
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

function setMessage(id, message) {
  const element = byId(id);
  if (element) element.textContent = message;
}

function showElement(id, show) {
  const element = byId(id);
  if (element) element.hidden = !show;
}

function logSupabaseError(label, error) {
  console.error(label, {
    message: error?.message || String(error),
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
    status: error?.status
  });
}

/* =========================================
   CATEGORY HELPERS

   Your database table does not contain a
   category column, so categories are inferred
   from the title and description.
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
   STORAGE PATH HELPERS

   Example audio_path:
   user-id/file-name.webm

   Do not include "podcasts/" at the start
   of audio_path.
========================================= */

function cleanStoragePath(value) {
  let path = String(value || "").trim();

  if (!path) return "";

  // A complete URL is not a Storage object path.
  if (validHttpUrl(path)) return path;

  path = path.replace(/^\/+/, "");

  // Remove the bucket name if it was saved
  // accidentally as part of audio_path.
  const prefix = `${AUDIO_BUCKET}/`;

  if (path.startsWith(prefix)) {
    path = path.slice(prefix.length);
  }

  return path;
}

/* =========================================
   RESOLVE PODCAST AUDIO URL

   1. Use audio_path if it is already a URL.
   2. Request a fresh signed URL.
   3. Try a saved audio_url.
   4. Try a public Storage URL.

   IMPORTANT:
   A generated URL does not prove that the
   object exists or that playback will work.
========================================= */

async function resolveAudioUrl(episode) {
  const rawPath = cleanStoragePath(episode.audio_path);
  const savedUrl = String(episode.audio_url || "").trim();

  // audio_path can contain a complete external URL.
  if (validHttpUrl(rawPath)) {
    return rawPath;
  }

  if (!rawPath) {
    console.error("Podcast has no audio_path:", {
      title: episode.title,
      id: episode.id
    });

    return validHttpUrl(savedUrl) ? savedUrl : "";
  }

  // First try a fresh signed URL.
  try {
    const { data, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(rawPath, 3600);

    if (!error && data?.signedUrl && validHttpUrl(data.signedUrl)) {
      return data.signedUrl;
    }

    if (error) {
      logSupabaseError(
        `Signed URL failed for "${episode.title}"`,
        error
      );
    }
  } catch (error) {
    logSupabaseError(
      `Signed URL request failed for "${episode.title}"`,
      error
    );
  }

  // A saved URL may still work if it is a valid public
  // URL or a signed URL that has not expired.
  if (validHttpUrl(savedUrl)) {
    console.warn(
      `Trying saved audio_url for "${episode.title}".`
    );

    return savedUrl;
  }

  // Try a public URL. This works only when the bucket
  // and object are publicly accessible.
  try {
    const { data } = supabase.storage
      .from(AUDIO_BUCKET)
      .getPublicUrl(rawPath);

    if (data?.publicUrl && validHttpUrl(data.publicUrl)) {
      console.warn(
        `Trying public Storage URL for "${episode.title}".`
      );

      return data.publicUrl;
    }
  } catch (error) {
    logSupabaseError(
      `Public URL creation failed for "${episode.title}"`,
      error
    );
  }

  return "";
}

/* =========================================
   PODCAST CARDS
========================================= */

function podcastCard(episode) {
  const category = inferCategory(episode);
  const audioUrl = episode.resolvedAudioUrl || "";
  const host = episode.host_name || "Mac&Talk Creator";
  const type = episode.episode_type || "podcast";

  const isReplay = type === "live_replay";
  const coverEmoji = isReplay ? "🔴" : "🎙️";
  const coverLabel = isReplay
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
          src="${safe(audioUrl)}"
          aria-label="Listen to ${safe(episode.title || "podcast")}"
        ></audio>

        <p class="audio-status" aria-live="polite">
          Loading audio…
        </p>
      </div>
    `
    : `
      <p class="audio-status audio-error" role="status">
        Audio URL unavailable. Check the audio file and Storage permissions.
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
        <p class="podcast-host">
          Hosted by ${safe(host)}
        </p>

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
   AUDIO PLAYER EVENTS
========================================= */

function setupAudioPlayers() {
  document.querySelectorAll(".podcast-audio").forEach((audio) => {
    if (audio.dataset.listenersReady === "true") return;

    audio.dataset.listenersReady = "true";

    const card = audio.closest(".podcast-card");
    const status = card?.querySelector(".audio-status");

    if (!status) return;

    audio.addEventListener("loadstart", () => {
      status.textContent = "Loading audio…";
      status.classList.remove("audio-error");
    });

    audio.addEventListener("loadedmetadata", () => {
      if (
        Number.isFinite(audio.duration) &&
        audio.duration > 0
      ) {
        const minutes = Math.floor(audio.duration / 60);
        const seconds = Math.floor(audio.duration % 60)
          .toString()
          .padStart(2, "0");

        status.textContent = `Duration: ${minutes}:${seconds}`;
        status.classList.remove("audio-error");
      } else if (audio.duration === Infinity) {
        status.textContent = "Audio stream ready.";
      } else {
        status.textContent =
          "Audio loaded, but duration is unavailable.";
      }
    });

    audio.addEventListener("canplay", () => {
      status.textContent = "Ready to play.";
      status.classList.remove("audio-error");
    });

    audio.addEventListener("playing", () => {
      status.textContent = "Playing";
      status.classList.remove("audio-error");
    });

    audio.addEventListener("waiting", () => {
      status.textContent = "Buffering audio…";
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

    audio.addEventListener("error", () => {
      const code = audio.error?.code;

      const messages = {
        1: "Audio loading was interrupted. Try again.",
        2: "Network error. Check your connection and audio URL.",
        3: "Audio could not be decoded. Check the file format or codec.",
        4: "Audio file missing or inaccessible. Check its Storage path and permissions."
      };

      status.textContent = messages[code] ||
        "Unable to load audio. Check the audio URL and file.";

      status.classList.add("audio-error");

      const title = card?.querySelector(".podcast-title")?.textContent;

      const episode = allEpisodes.find(
        (item) => item.title === title
      );

      console.error("Mac&Talk podcast playback failed:", {
        title,
        episodeId: episode?.id,
        audioPath: episode?.audio_path,
        savedAudioUrl: episode?.audio_url,
        source: audio.currentSrc,
        errorCode: code,
        errorMessage: audio.error?.message
      });
    });

    // Recheck the source after listeners have been attached.
    audio.load();
  });
}

/* =========================================
   SEARCH AND CATEGORY FILTER
========================================= */

function filterPodcasts() {
  const grid = byId("podcastGrid");
  if (!grid) return;

  const query = (byId("searchInput")?.value || "")
    .trim()
    .toLowerCase();

  const selectedCategory =
    byId("categoryFilter")?.value || "all";

  let visibleCount = 0;

  grid.querySelectorAll(".podcast-card").forEach((card) => {
    const searchText = card.dataset.search || "";
    const category = card.dataset.category || "everyday";

    const matchesSearch =
      !query || searchText.includes(query);

    const matchesCategory =
      selectedCategory === "all" ||
      selectedCategory === category;

    const visible = matchesSearch && matchesCategory;

    card.hidden = !visible;

    if (visible) visibleCount++;
  });

  const noPodcasts = byId("noPodcasts");

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
  byId("searchInput")?.addEventListener(
    "input",
    filterPodcasts
  );

  byId("categoryFilter")?.addEventListener(
    "change",
    filterPodcasts
  );
}

/* =========================================
   LOAD LATEST PUBLISHED PODCASTS

   Required HTML:
   <div id="podcastGrid"></div>
   <p id="noPodcasts" hidden></p>

   Optional:
   <input id="searchInput">
   <select id="categoryFilter">...</select>
========================================= */

async function loadPodcasts() {
  const grid = byId("podcastGrid");

  if (!grid) {
    console.warn("Mac&Talk: #podcastGrid was not found.");
    return;
  }

  setMessage("noPodcasts", "Loading podcasts…");
  showElement("noPodcasts", true);

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

    const episodes = data || [];

    if (episodes.length === 0) {
      allEpisodes = [];
      grid.innerHTML = "";

      showElement("noPodcasts", true);
      setMessage(
        "noPodcasts",
        "No published podcasts are available yet."
      );

      return;
    }

    // Resolve each episode independently. One broken file
    // should not prevent other podcast cards from appearing.
    allEpisodes = await Promise.all(
      episodes.map(async (episode) => {
        try {
          const resolvedAudioUrl = await resolveAudioUrl(episode);

          return {
            ...episode,
            resolvedAudioUrl
          };
        } catch (error) {
          logSupabaseError(
            `Audio resolution failed for "${episode.title}"`,
            error
          );

          return {
            ...episode,
            resolvedAudioUrl: ""
          };
        }
      })
    );

    grid.innerHTML = allEpisodes.map(podcastCard).join("");

    setupAudioPlayers();
    filterPodcasts();

    console.info("Mac&Talk podcasts loaded:", {
      total: allEpisodes.length,
      withAudioUrl: allEpisodes.filter(
        (episode) => Boolean(episode.resolvedAudioUrl)
      ).length,
      withoutAudioUrl: allEpisodes.filter(
        (episode) => !episode.resolvedAudioUrl
      ).length
    });

  } catch (error) {
    logSupabaseError("Could not load Mac&Talk podcasts", error);

    grid.innerHTML = "";
    allEpisodes = [];

    showElement("noPodcasts", true);
    setMessage(
      "noPodcasts",
      "Could not load podcasts. Check Supabase table permissions and the browser console."
    );
  }
}

/* =========================================
   LIVE SESSION COVER
========================================= */

function cover(session) {
  if (validHttpUrl(session.cover_image_url || "")) {
    return `
      <img
        class="session-cover-image"
        src="${safe(session.cover_image_url)}"
        alt=""
        loading="lazy"
      >
    `;
  }

  return `
    <span class="session-cover-emoji" aria-hidden="true">
      ${safe(session.emoji || "🎙️")}
    </span>
  `;
}

/* =========================================
   LIVE SESSION CARDS
========================================= */

function liveCard(session) {
  const joinUrl = validHttpUrl(session.join_url || "")
    ? session.join_url
    : "";
  const startedAt = session.started_at || "";
  const elapsed = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;
  const hasStart = Boolean(startedAt && Number.isFinite(new Date(startedAt).getTime()));

  return `
    <article class="live-card">
      <div class="session-cover">
        ${cover(session)}
        <span class="live-badge">LIVE</span>
      </div>

      <div class="session-content">
        <h3>${safe(session.title || "Live broadcast")}</h3>
        <p>${safe(session.description || "Join the conversation on Mac&Talk.")}</p>
        ${session.host_name || session.host ? `<p class="session-note">Hosted by ${safe(session.host_name || session.host)}</p>` : ""}
        <div class="session-timer" aria-label="Live session elapsed time">
          <span>⏱ Live duration</span>
          <strong class="live-timer" data-started-at="${safe(startedAt)}">${hasStart ? formatElapsed(elapsed) : "Timer unavailable"}</strong>
        </div>
        ${
          joinUrl
            ? `<a class="session-button" href="${safe(joinUrl)}" target="_blank" rel="noopener noreferrer">Join Live</a>`
            : `<p class="session-note">The listening link is not available yet.</p>`
        }
      </div>
    </article>
  `;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
}

function updateLiveTimers() {
  document.querySelectorAll(".live-timer[data-started-at]").forEach((timer) => {
    const start = new Date(timer.dataset.startedAt).getTime();
    if (!Number.isFinite(start)) {
      timer.textContent = "Timer unavailable";
      return;
    }
    timer.textContent = formatElapsed(Date.now() - start);
  });
}

function endedCard(session) {
  const recordingUrl = validHttpUrl(session.recording_url || "")
    ? session.recording_url
    : "";
  const host = session.host_name || session.host || "";
  const started = session.started_at ? new Date(session.started_at).getTime() : NaN;
  const ended = session.ended_at ? new Date(session.ended_at).getTime() : NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? ended - started
    : (Number.isFinite(Number(session.duration_seconds)) && Number(session.duration_seconds) >= 0
        ? Number(session.duration_seconds) * 1000
        : 0);
  const durationText = durationMs > 0 ? formatElapsed(durationMs) : "Duration unavailable";
  const endedDate = session.ended_at || session.updated_at || session.created_at;

  return `
    <article class="ended-card">
      <div class="session-cover">
        ${cover(session)}
        <span class="ended-badge">SESSION ENDED</span>
      </div>
      <div class="session-content">
        ${host ? `<p class="ended-host">Hosted by ${safe(host)}</p>` : ""}
        <h3>${safe(session.title || "Mac&Talk conversation")}</h3>
        <p>${safe(session.description || "A past conversation from Mac&Talk.")}</p>
        <p class="ended-duration">◷ ${safe(durationText)}</p>
        <p class="session-date">${safe(niceDate(endedDate))}</p>
        <div class="ended-actions">
          ${
            recordingUrl
              ? `<a class="card-link" href="${safe(recordingUrl)}" target="_blank" rel="noopener noreferrer">▶ Replay session</a>`
              : `<span class="card-link secondary disabled" aria-disabled="true">Replay unavailable</span>`
          }
        </div>
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

        <p>
          ${safe(session.description || "A new Mac&Talk broadcast is coming soon.")}
        </p>

        <p class="session-date">
          ${safe(niceDate(session.scheduled_at))}
        </p>

        ${
          joinUrl
            ? `
              <a
                class="session-button"
                href="${safe(joinUrl)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Session
              </a>
            `
            : `
              <p class="session-note">
                The session link will be available when provided.
              </p>
            `
        }
      </div>
    </article>
  `;
}

/* =========================================
   LIVE EMPTY STATES
========================================= */

function showEmptyStates(liveCount, upcomingCount, endedCount = 0) {
  showElement("noLive", liveCount === 0);
  showElement("noUpcoming", upcomingCount === 0);
  showElement("noEnded", endedCount === 0);

  if (liveCount === 0) {
    setMessage(
      "noLive",
      "There are no live broadcasts right now."
    );
  }

  if (upcomingCount === 0) {
    setMessage(
      "noUpcoming",
      "There are no upcoming broadcasts yet."
    );
  }

  if (endedCount === 0) {
    setMessage("noEnded", "No completed live sessions are available yet.");
  }
}

/* =========================================
   LOAD LIVE AND UPCOMING SESSIONS

   Reads the columns from your live_sessions table.
========================================= */

async function loadLiveSessions() {
  const liveGrid = byId("liveGrid");
  const upcomingGrid = byId("upcomingGrid");
  const endedGrid = byId("endedGrid");

  if (!liveGrid || !upcomingGrid) {
    console.warn("Mac&Talk: #liveGrid or #upcomingGrid was not found.");
    return;
  }

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
        emoji,
        status,
        approved,
        created_at,
        updated_at,
        host,
        host_name,
        started_at,
        ended_at,
        duration_seconds,
        recording_url
      `)
      .eq("approved", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const sessions = data || [];
    const now = Date.now();

    const liveSessions = sessions.filter(session =>
      String(session.status || "").toLowerCase() === "live"
    );

    const upcomingSessions = sessions.filter(session => {
      if (String(session.status || "").toLowerCase() !== "scheduled") return false;
      if (!session.scheduled_at) return true;
      const scheduledTime = new Date(session.scheduled_at).getTime();
      return Number.isFinite(scheduledTime) && scheduledTime >= now;
    });

    const endedSessions = sessions.filter(session =>
      ["ended", "completed", "finished"].includes(String(session.status || "").toLowerCase())
    );

    liveGrid.innerHTML = liveSessions.map(liveCard).join("");
    upcomingGrid.innerHTML = upcomingSessions.map(upcomingCard).join("");
    if (endedGrid) endedGrid.innerHTML = endedSessions.map(endedCard).join("");

    updateLiveTimers();
    showEmptyStates(liveSessions.length, upcomingSessions.length, endedSessions.length);

    setMessage("liveMessage", "");

    console.info("Mac&Talk sessions loaded:", {
      totalRows: sessions.length,
      live: liveSessions.length,
      upcoming: upcomingSessions.length,
      ended: endedSessions.length
    });
  } catch (error) {
    logSupabaseError("Could not load Mac&Talk live sessions", error);
    setMessage(
      "liveMessage",
      "Live broadcasts could not be loaded. Check the live_sessions columns and Supabase permissions."
    );
    liveGrid.innerHTML = "";
    upcomingGrid.innerHTML = "";
    if (endedGrid) endedGrid.innerHTML = "";
    showEmptyStates(0, 0, 0);
  }
}

/* =========================================
   MOBILE NAVIGATION
========================================= */

function setupNavigation() {
  const menuToggle = byId("menuToggle");
  const navLinks = byId("navLinks");

  if (!menuToggle || !navLinks) return;

  menuToggle.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("active");

    menuToggle.setAttribute(
      "aria-expanded",
      String(isOpen)
    );

    menuToggle.setAttribute(
      "aria-label",
      isOpen
        ? "Close navigation menu"
        : "Open navigation menu"
    );
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("active");

      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute(
        "aria-label",
        "Open navigation menu"
      );
    });
  });
}

/* =========================================
   INITIALIZE WEBSITE
========================================= */

async function initialize() {
  const year = byId("currentYear");

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  setupNavigation();
  setupPodcastSearch();

  await Promise.allSettled([
    loadPodcasts(),
    loadLiveSessions()
  ]);
}

initialize();

/* =========================================
   AUTOMATIC LIVE SESSION REFRESH

   Refreshes live sessions every 30 seconds.
   Podcast audio players are not rebuilt.
========================================= */

setInterval(async () => {
  if (refreshInProgress) return;

  refreshInProgress = true;

  try {
    await loadLiveSessions();
  } catch (error) {
    console.error(
      "Mac&Talk automatic session refresh failed:",
      error
    );
  } finally {
    refreshInProgress = false;
  }
}, LIVE_REFRESH_MS);


// Keep elapsed live-session timers accurate between database refreshes.
setInterval(updateLiveTimers, 1000);
