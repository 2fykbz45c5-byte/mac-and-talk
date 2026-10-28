
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
let feedbackSummary = new Map();

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

function canonicalItemUrl(type, id) {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set(type === "live" ? "live" : "podcast", String(id));
  return url.toString();
}

function shareButton(type, id, title) {
  return `<button type="button" class="card-link share-item-button" data-share-type="${type}" data-share-id="${safe(id)}" data-share-title="${safe(title || "Mac&Talk")}">↗ Share</button>`;
}

function calendarButton(session) {
  if (!session.scheduled_at || !Number.isFinite(new Date(session.scheduled_at).getTime())) return "";
  return `<button type="button" class="card-link calendar-item-button" data-calendar-id="${safe(session.id)}" data-calendar-title="${safe(session.title || "Mac&Talk session")}" data-calendar-start="${safe(session.scheduled_at)}" data-calendar-description="${safe(session.description || "Mac&Talk live session")}">＋ Add to Calendar</button>`;
}

function googleCalendarDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function openGoogleCalendar(button) {
  const start = new Date(button.dataset.calendarStart);
  if (!Number.isFinite(start.getTime())) return;

  // Google opens a prefilled event; the visitor confirms it by pressing Save.
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const eventUrl = canonicalItemUrl("live", button.dataset.calendarId);
  const details = `${button.dataset.calendarDescription || "Mac&Talk live session"}\n\nJoin or view the session: ${eventUrl}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: button.dataset.calendarTitle || "Mac&Talk session",
    dates: `${googleCalendarDate(start)}/${googleCalendarDate(end)}`,
    details,
    location: eventUrl
  });
  const googleUrl = `https://calendar.google.com/calendar/render?${params.toString()}`;
  window.open(googleUrl, "_blank", "noopener,noreferrer");
}

function focusSharedItem() {
  const params = new URLSearchParams(window.location.search);
  const target = params.has("live") ? { type: "live", id: params.get("live") }
    : params.has("podcast") ? { type: "podcast", id: params.get("podcast") } : null;
  if (!target) return;
  const selector = target.type === "live" ? `[data-live-id="${CSS.escape(target.id)}"]` : `[data-podcast-id="${CSS.escape(target.id)}"]`;
  const card = document.querySelector(selector);
  if (!card || card.dataset.sharedFocusDone === "true") return;
  card.dataset.sharedFocusDone = "true";
  card.classList.add("shared-item-highlight");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setupShareAndCalendarActions() {
  document.addEventListener("click", async event => {
    const share = event.target.closest(".share-item-button");
    if (share) {
      const url = canonicalItemUrl(share.dataset.shareType, share.dataset.shareId);
      try {
        if (navigator.share) await navigator.share({ title: share.dataset.shareTitle, url });
        else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          const old = share.textContent; share.textContent = "✓ Link copied";
          setTimeout(() => { share.textContent = old; }, 1800);
        } else window.prompt("Copy this link to share:", url);
      } catch (error) {
        if (error?.name !== "AbortError") window.prompt("Copy this link to share:", url);
      }
      return;
    }
    const calendar = event.target.closest(".calendar-item-button");
    if (calendar) openGoogleCalendar(calendar);
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
   FEEDBACK / RATINGS
========================================= */

function feedbackKey(type, id) {
  return `${type}:${id}`;
}

function feedbackSummaryMarkup(type, id) {
  const summary = feedbackSummary.get(feedbackKey(type, id));
  if (!summary || !summary.count) {
    return `<p class="feedback-summary" data-rating-summary="${safe(type)}:${safe(id)}">☆ No ratings yet</p>`;
  }
  return `<p class="feedback-summary" data-rating-summary="${safe(type)}:${safe(id)}"><span aria-label="Average rating">★ ${summary.average.toFixed(1)}/5</span> <span>(${summary.count} ${summary.count === 1 ? "rating" : "ratings"})</span></p>`;
}

function feedbackForm(type, id, title) {
  if (!id) return "";
  return `
    <div class="feedback-panel" data-rating-widget="${safe(type)}:${safe(id)}">
      <p class="rating-prompt">Rate this ${type === "live" ? "live session" : "podcast"}</p>
      <div class="rating-stars" role="group" aria-label="Rate from one to five stars" data-feedback-type="${safe(type)}" data-content-id="${safe(id)}" data-content-title="${safe(title || "Mac&Talk content")}">
        ${[1,2,3,4,5].map(n => `<button type="button" class="rating-star" data-rating="${n}" aria-label="${n} ${n === 1 ? "star" : "stars"}" title="${n} ${n === 1 ? "star" : "stars"}">★</button>`).join("")}
      </div>
      <p class="feedback-status" role="status" aria-live="polite"></p>
      <form class="feedback-comment-form" data-comment-type="${safe(type)}" data-content-id="${safe(id)}">
        <textarea name="comment" maxlength="1000" placeholder="Write a comment (up to 1000 characters)..." aria-label="Write a comment" required></textarea>
        <button class="card-link" type="submit">Post comment</button>
      </form>
      <div class="feedback-comments" data-comments-for="${safe(type)}:${safe(id)}"></div>
    </div>
  `;
}

async function loadFeedbackSummaries() {
  try {
    const { data, error } = await supabase
      .from("content_feedback")
      .select("content_type, content_id, rating")
      .eq("approved", true);
    if (error) throw error;

    const totals = new Map();
    for (const item of data || []) {
      const key = feedbackKey(item.content_type, item.content_id);
      const current = totals.get(key) || { count: 0, total: 0 };
      current.count += 1;
      current.total += Number(item.rating) || 0;
      totals.set(key, current);
    }
    feedbackSummary = new Map([...totals.entries()].map(([key, value]) => [key, {
      count: value.count,
      average: value.total / value.count
    }]));
    document.querySelectorAll("[data-rating-summary]").forEach((element) => {
      const [type, id] = element.dataset.ratingSummary.split(":");
      element.outerHTML = feedbackSummaryMarkup(type, id);
    });
  } catch (error) {
    logSupabaseError("Could not load feedback ratings", error);
  }
}

let currentAccount = null;
let accountMode = "signup";
function openAccount(mode = "signup") {
  accountMode = mode;
  const modal = byId("accountModal");
  if (!modal) return;
  modal.hidden = false; updateAccountMode();
  byId("accountStatus").textContent = "";
  byId("accountEmail")?.focus();
}
function closeAccount() { if (byId("accountModal")) byId("accountModal").hidden = true; }
function updateAccountMode() {
  const signup = accountMode === "signup";
  byId("signupTab")?.classList.toggle("active", signup);
  byId("loginTab")?.classList.toggle("active", !signup);
  if (byId("accountNameField")) byId("accountNameField").hidden = !signup;
  if (byId("accountPassword")) byId("accountPassword").autocomplete = signup ? "new-password" : "current-password";
  if (byId("accountSubmit")) byId("accountSubmit").textContent = signup ? "Create account" : "Log in";
  if (byId("accountTitle")) byId("accountTitle").textContent = signup ? "Join the conversation" : "Welcome back";
}
function updateAccountButton() {
  const button = byId("accountButton");
  if (button) { button.textContent = currentAccount ? "Log out" : "Create account"; button.title = currentAccount ? `Signed in as ${currentAccount.email || "member"}` : "Create an account to rate and comment"; }
}
function setupAccount() {
  byId("accountButton")?.addEventListener("click", async () => {
    if (currentAccount) {
      const { error } = await supabase.auth.signOut();
      if (error) console.error("Could not log out:", error.message);
      currentAccount = null; updateAccountButton(); return;
    }
    openAccount("signup");
  });
  byId("signupTab")?.addEventListener("click", () => { accountMode = "signup"; updateAccountMode(); });
  byId("loginTab")?.addEventListener("click", () => { accountMode = "login"; updateAccountMode(); });
  document.querySelectorAll("[data-close-account]").forEach(el => el.addEventListener("click", closeAccount));
  byId("accountForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const status = byId("accountStatus"), submit = byId("accountSubmit");
    const email = byId("accountEmail").value.trim(), password = byId("accountPassword").value;
    const displayName = byId("accountName").value.trim();
    status.classList.remove("error"); status.textContent = accountMode === "signup" ? "Creating your account…" : "Logging in…"; submit.disabled = true;
    try {
      if (accountMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName || email.split("@")[0], purpose: "ratings_comments" } } });
        if (error) throw error;
        if (data.session) { currentAccount = data.user; closeAccount(); }
        else status.textContent = "Account created. Check your email to confirm it, then log in here.";
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        currentAccount = data.user; closeAccount();
      }
      updateAccountButton();
    } catch (error) { status.classList.add("error"); status.textContent = error.message || "Could not complete account action."; }
    finally { submit.disabled = false; }
  });
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) console.error("Could not check account session:", error.message);
    currentAccount = data?.session?.user || null; updateAccountButton();
  });
  supabase.auth.onAuthStateChange((_event, session) => { currentAccount = session?.user || null; updateAccountButton(); });
}
async function requireFeedbackAccount() {
  if (currentAccount) return true;
  openAccount("signup");
  if (byId("accountStatus")) byId("accountStatus").textContent = "Create an account or log in to rate and comment.";
  return false;
}
async function loadComments(type, id) {
  const target = document.querySelector(`[data-comments-for="${CSS.escape(`${type}:${id}`)}"]`);
  if (!target) return;
  try {
    const { data, error } = await supabase.from("content_comments").select("id, display_name, comment, created_at")
      .eq("content_type", type).eq("content_id", id).eq("approved", true).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    target.innerHTML = (data || []).map(item => `<div class="feedback-comment"><strong>${safe(item.display_name || "Mac&Talk member")}</strong>${safe(item.comment)}<time>${safe(niceDate(item.created_at))}</time></div>`).join("");
  } catch (error) { console.error("Could not load comments:", error.message || error); }
}
function loadAllComments() {
  document.querySelectorAll("[data-comments-for]").forEach(el => { const [type, id] = el.dataset.commentsFor.split(":"); loadComments(type, id); });
}

function setupFeedbackForms() {
  document.addEventListener("click", async (event) => {
    const star = event.target.closest(".rating-star");
    if (!star) return;

    const stars = star.closest(".rating-stars");
    const widget = star.closest(".feedback-panel");
    const status = widget?.querySelector(".feedback-status");
    if (!stars || !status || stars.dataset.submitting === "true") return;

    const rating = Number(star.dataset.rating);
    const contentType = stars.dataset.feedbackType;
    const contentId = stars.dataset.contentId;
    if (!contentId || !["live", "podcast"].includes(contentType) || !Number.isInteger(rating) || rating < 1 || rating > 5) return;
    if (!(await requireFeedbackAccount())) return;

    stars.dataset.submitting = "true";
    stars.querySelectorAll("button").forEach(button => {
      button.disabled = true;
      button.classList.toggle("selected", Number(button.dataset.rating) <= rating);
    });
    status.textContent = "Saving your rating…";

    try {
      const { error } = await supabase.from("content_feedback").insert({
        content_type: contentType,
        content_id: contentId,
        rating,
        user_id: currentAccount.id,
        approved: true
      });
      if (error) throw error;

      const key = feedbackKey(contentType, contentId);
      const current = feedbackSummary.get(key) || { count: 0, average: 0 };
      const count = current.count + 1;
      const average = ((current.average * current.count) + rating) / count;
      feedbackSummary.set(key, { count, average });

      const card = widget.closest("article");
      const summary = card?.querySelector(`[data-rating-summary="${CSS.escape(key)}"]`);
      if (summary) summary.outerHTML = feedbackSummaryMarkup(contentType, contentId);
      status.textContent = "Thanks for rating!";
      stars.setAttribute("aria-label", `You rated ${rating} out of 5 stars`);
    } catch (error) {
      logSupabaseError("Could not submit rating", error);
      // Keep the visitor-facing message simple while exposing the exact
      // Supabase reason in the browser console for troubleshooting.
      const reason = error?.message || error?.details || error?.hint || "Unknown Supabase error";
      status.textContent = "Could not save your rating. Please try again.";
      status.title = reason;
      console.error("Rating save failed — Supabase details:", {
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
        code: error?.code,
        contentType,
        contentId
      });
      stars.querySelectorAll("button").forEach(button => {
        button.disabled = false;
        button.classList.remove("selected");
      });
    } finally {
      stars.dataset.submitting = "false";
    }
  });

  document.addEventListener("submit", async event => {
    const form = event.target.closest(".feedback-comment-form");
    if (!form) return;
    event.preventDefault();
    if (!(await requireFeedbackAccount())) return;
    const textarea = form.querySelector("textarea"), button = form.querySelector('button[type="submit"]');
    const comment = textarea.value.trim();
    if (!comment) return;
    button.disabled = true; const original = button.textContent; button.textContent = "Posting…";
    try {
      const { error } = await supabase.from("content_comments").insert({
        content_type: form.dataset.commentType, content_id: form.dataset.contentId,
        user_id: currentAccount.id,
        display_name: currentAccount.user_metadata?.display_name || currentAccount.email?.split("@")[0] || "Mac&Talk member",
        comment, approved: false
      });
      if (error) throw error;
      textarea.value = "";
      const status = form.closest(".feedback-panel")?.querySelector(".feedback-status");
      if (status) { status.classList.remove("error"); status.textContent = "Comment submitted for review."; }
    } catch (error) {
      console.error("Could not post comment:", error);
      const status = form.closest(".feedback-panel")?.querySelector(".feedback-status");
      if (status) { status.classList.add("error"); status.textContent = error.message || "Could not post comment. Please try again."; }
    } finally { button.disabled = false; button.textContent = original; }
  });
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
      data-podcast-id="${safe(episode.id)}"
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
        <div class="item-action-row">${shareButton("podcast", episode.id, episode.title)}</div>
        ${feedbackSummaryMarkup("podcast", episode.id)}
        ${feedbackForm("podcast", episode.id, episode.title)}
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
    focusSharedItem();
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
    <article class="live-card" data-live-id="${safe(session.id)}">
      <div class="session-cover">
        ${cover(session)}
        <span class="live-badge">LIVE</span>
      </div>

      <div class="session-content">
        <h3>${safe(session.title || "Live broadcast")}</h3>
        <p>${safe(session.description || "Join the conversation on Mac&Talk.")}</p>
        ${session.host_name || session.host ? `<p class="session-note session-host">Hosted by ${safe(session.host_name || session.host)}</p>` : ""}
        ${session.invitedNames?.length ? `<p class="session-note session-invitees"><strong>Invited:</strong> ${safe(session.invitedNames.join(", "))}</p>` : ""}
        <div class="item-action-row">${shareButton("live", session.id, session.title)}</div>
        <div class="session-timer" aria-label="Live session elapsed time">
          <span>⏱ Live duration</span>
          <strong class="live-timer" data-started-at="${safe(startedAt)}">${hasStart ? formatElapsed(elapsed) : "Timer unavailable"}</strong>
        </div>
        ${
          joinUrl
            ? `<a class="session-button" href="${safe(joinUrl)}" target="_blank" rel="noopener noreferrer">Join Live</a>`
            : `<p class="session-note">The listening link is not available yet.</p>`
        }
        ${feedbackSummaryMarkup("live", session.id)}
        ${feedbackForm("live", session.id, session.title)}
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
    <article class="ended-card" data-live-id="${safe(session.id)}">
      <div class="session-cover">
        ${cover(session)}
        <span class="ended-badge">SESSION ENDED</span>
      </div>
      <div class="session-content">
        ${host ? `<p class="ended-host">Hosted by ${safe(host)}</p>` : ""}
        <h3>${safe(session.title || "Mac&Talk conversation")}</h3>
        <p>${safe(session.description || "A past conversation from Mac&Talk.")}</p>
        ${session.invitedNames?.length ? `<p class="session-note session-invitees"><strong>Invited:</strong> ${safe(session.invitedNames.join(", "))}</p>` : ""}
        <p class="ended-duration">◷ ${safe(durationText)}</p>
        <p class="session-date">${safe(niceDate(endedDate))}</p>
        <div class="ended-actions">
          ${
            recordingUrl
              ? `<a class="card-link" href="${safe(recordingUrl)}" target="_blank" rel="noopener noreferrer">▶ Replay session</a>`
              : `<span class="card-link secondary disabled" aria-disabled="true">Replay unavailable</span>`
          }
        </div>
        <div class="item-action-row">${shareButton("live", session.id, session.title)}</div>
        ${feedbackSummaryMarkup("live", session.id)}
        ${feedbackForm("live", session.id, session.title)}
      </div>
    </article>
  `;
}

function upcomingCard(session) {
  const joinUrl = validHttpUrl(session.join_url || "")
    ? session.join_url
    : "";

  return `
    <article class="upcoming-card" data-live-id="${safe(session.id)}">
      <div class="session-cover">
        ${cover(session)}
        <span class="upcoming-badge">UPCOMING</span>
      </div>

      <div class="session-content">
        <h3>${safe(session.title || "Upcoming broadcast")}</h3>

        <p>
          ${safe(session.description || "A new Mac&Talk broadcast is coming soon.")}
        </p>

        ${session.host_name || session.host ? `<p class="session-note session-host">Hosted by ${safe(session.host_name || session.host)}</p>` : ""}
        ${session.invitedNames?.length ? `<p class="session-note session-invitees"><strong>Invited:</strong> ${safe(session.invitedNames.join(", "))}</p>` : ""}
        <p class="session-date">
          ${safe(niceDate(session.scheduled_at))}
        </p>
        ${session.scheduled_at ? `
          <div class="session-countdown" aria-live="off">
            <span class="countdown-label">STARTS IN</span>
            <strong class="countdown-timer" data-scheduled-at="${safe(session.scheduled_at)}">${safe(formatCountdown(new Date(session.scheduled_at).getTime() - Date.now()))}</strong>
          </div>
        ` : `
          <div class="session-countdown session-countdown-unscheduled">
            <span class="countdown-label">START TIME</span>
            <strong class="countdown-timer">To be announced</strong>
          </div>
        `}

        <div class="item-action-row">${shareButton("live", session.id, session.title)}${calendarButton(session)}</div>
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

function formatCountdown(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "Time not set";
  if (milliseconds <= 0) return "Starting now";

  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = value => String(value).padStart(2, "0");

  return days > 0
    ? `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
    : `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

function updateCountdownTimers() {
  document.querySelectorAll(".countdown-timer[data-scheduled-at]").forEach(timer => {
    const scheduledAt = new Date(timer.dataset.scheduledAt).getTime();
    timer.textContent = formatCountdown(scheduledAt - Date.now());
    const container = timer.closest(".session-countdown");
    if (container) container.classList.toggle("session-countdown-due", scheduledAt <= Date.now());
  });
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

async function attachInviteeNames(sessions) {
  if (!sessions.length) return;
  try {
    const { data: inviteRows, error: inviteError } = await supabase
      .from("live_session_invitees")
      .select("session_id,user_id")
      .in("session_id", sessions.map(session => session.id));
    if (inviteError) {
      console.warn("Invitee names are unavailable (check public SELECT policies):", inviteError.message);
      return;
    }
    const rows = inviteRows || [];
    const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];
    if (!userIds.length) return;
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id,display_name,username")
      .in("id", userIds);
    if (profilesError) {
      console.warn("Invitee profile names are unavailable (check public SELECT policies):", profilesError.message);
      return;
    }
    const names = new Map((profiles || []).map(profile => [profile.id, profile.display_name || profile.username || "Invited guest"]));
    const bySession = new Map();
    rows.forEach(row => {
      const name = names.get(row.user_id);
      if (!name) return;
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
      if (!bySession.get(row.session_id).includes(name)) bySession.get(row.session_id).push(name);
    });
    sessions.forEach(session => { session.invitedNames = bySession.get(session.id) || []; });
  } catch (error) {
    console.warn("Could not load invitee names:", error);
  }
}

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
    await attachInviteeNames(sessions);
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

    focusSharedItem();
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

function setupCarouselButtons() {
  document.querySelectorAll("[data-carousel-target][data-direction]").forEach((button) => {
    button.addEventListener("click", () => {
      const track = byId(button.dataset.carouselTarget);
      if (!track) return;
      const firstCard = track.querySelector(".live-card, .upcoming-card, .ended-card, .podcast-card");
      const gap = 14;
      const step = firstCard ? firstCard.getBoundingClientRect().width + gap : track.clientWidth * 0.8;
      track.scrollBy({ left: Number(button.dataset.direction) * step, behavior: "smooth" });
    });
  });
}

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
  setupCarouselButtons();
  setupPodcastSearch();
  setupFeedbackForms();
  setupAccount();
  setupShareAndCalendarActions();
  await loadFeedbackSummaries();

  await Promise.allSettled([
    loadPodcasts(),
    loadLiveSessions()
  ]);
  loadAllComments();
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

// Keep scheduled-start countdowns updating every second.
setInterval(updateCountdownTimers, 1000);
