
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://gprdmwjqgyrvqrgjkycc.supabase.co";
const SUPABASE_KEY = "sb_publishable_uBlQa2v-VS9OYVRk3FEE4A_CwmVPVH4";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);

const safe = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);

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
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function cover(url, icon = "🎙️") {
  if (validHttpUrl(url)) {
    return `
      <img
        src="${safe(url)}"
        alt=""
        loading="lazy"
        onerror="this.remove()"
      >
    `;
  }

  return `<span class="cover-icon">${icon}</span>`;
}

function liveCard(session) {
  const join = validHttpUrl(session.join_url)
    ? `
      <a
        class="card-link"
        href="${safe(session.join_url)}"
        target="_blank"
        rel="noopener noreferrer"
      >Join live ↗</a>
    `
    : `<span class="card-link disabled">Link coming soon</span>`;

  return `
    <article class="live-card">
      <div class="card-cover">
        ${cover(session.cover_image_url)}
        <span class="card-tag">🔴 LIVE NOW</span>
      </div>

      <div class="card-body">
        <h3>${safe(session.title || "Mac&Talk live session")}</h3>
        <p>${safe(session.description || "Join the Mac&Talk community.")}</p>

        <div class="card-meta">
          <span>🎙️ Live broadcast</span>
          <span>•</span>
          <span>Mac&Talk</span>
        </div>

        <div class="card-actions">${join}</div>
      </div>
    </article>
  `;
}

function upcomingCard(session) {
  const join = validHttpUrl(session.join_url)
    ? `
      <a
        class="card-link secondary"
        href="${safe(session.join_url)}"
        target="_blank"
        rel="noopener noreferrer"
      >Session link ↗</a>
    `
    : `
      <span class="card-link secondary disabled">
        Link not available yet
      </span>
    `;

  return `
    <article class="upcoming-card">
      <div class="card-cover">
        ${cover(session.cover_image_url, "📅")}
        <span class="card-tag">📅 UPCOMING</span>
      </div>

      <div class="card-body">
        <h3>${safe(session.title || "Upcoming session")}</h3>
        <p>${safe(session.description || "A new Mac&Talk session is coming soon.")}</p>

        <div class="card-meta">
          <span>🗓️ ${safe(niceDate(session.scheduled_at))}</span>
        </div>

        <div class="card-actions">${join}</div>
      </div>
    </article>
  `;
}

function setMessage(message, isError = false) {
  const el = $("liveMessage");

  if (!el) return;

  el.textContent = message;
  el.style.color = isError ? "#b63241" : "";
}

function showEmptyStates(liveCount, upcomingCount) {
  $("noLive")?.classList.toggle("hidden", liveCount > 0);
  $("noUpcoming")?.classList.toggle("hidden", upcomingCount > 0);
}

async function loadLiveSessions() {
  setMessage("Loading Mac&Talk sessions…");

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
      .order("scheduled_at", {
        ascending: true,
        nullsFirst: false
      });

    if (error) throw error;

    const rows = (data || []).map((session) => ({
      ...session,
      status: String(session.status || "").trim().toLowerCase(),
      approved: session.approved === true
    }));

    const now = Date.now();

    // Only approved broadcasts appear in Live Now.
    const live = rows.filter(
      (session) =>
        session.approved &&
        session.status === "live"
    );

    // Only approved scheduled sessions appear in Coming Up.
    const upcoming = rows.filter((session) => {
      if (!session.approved) return false;
      if (session.status !== "scheduled") return false;

      // A scheduled session with no date is still displayed.
      if (!session.scheduled_at) return true;

      const timestamp = new Date(session.scheduled_at).getTime();

      return Number.isFinite(timestamp) && timestamp >= now;
    });

    const liveGrid = $("liveGrid");
    const upcomingGrid = $("upcomingGrid");

    if (!liveGrid || !upcomingGrid) {
      throw new Error(
        "Cannot find #liveGrid or #upcomingGrid. Check the IDs in index.html."
      );
    }

    liveGrid.innerHTML = live.map(liveCard).join("");
    upcomingGrid.innerHTML = upcoming.map(upcomingCard).join("");

    showEmptyStates(live.length, upcoming.length);

    setMessage(
      `${live.length} live session(s) · ${upcoming.length} upcoming session(s)`
    );

    console.log("Mac&Talk sessions loaded:", {
      totalRows: rows.length,
      live: live.length,
      upcoming: upcoming.length,
      sessions: rows
    });
  } catch (error) {
    console.error("Mac&Talk session loading failed:", error);

    if ($("liveGrid")) $("liveGrid").innerHTML = "";
    if ($("upcomingGrid")) $("upcomingGrid").innerHTML = "";

    $("noLive")?.classList.remove("hidden");
    $("noUpcoming")?.classList.remove("hidden");

    setMessage(
      `Unable to load sessions: ${error.message || "Unknown error"}`,
      true
    );
  }
}

function setupNavigation() {
  const toggle = $("menuToggle");
  const nav = $("navLinks");

  toggle?.addEventListener("click", () => {
    if (!nav) return;

    const open = nav.classList.toggle("open");

    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "×" : "☰";
  });

  nav?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      toggle?.setAttribute("aria-expanded", "false");

      if (toggle) toggle.textContent = "☰";
    });
  });
}

function setupPodcastSearch() {
  const search = $("searchInput");
  const filter = $("categoryFilter");
  const grid = $("podcastGrid");
  const empty = $("noPodcasts");

  if (!search || !filter || !grid || !empty) return;

  const update = () => {
    const cards = [...grid.children];
    const query = search.value.trim().toLowerCase();
    const category = filter.value;
    let visible = 0;

    cards.forEach((card) => {
      const matchesText =
        card.textContent.toLowerCase().includes(query);

      const matchesCategory =
        category === "all" || card.dataset.category === category;

      const show = matchesText && matchesCategory;

      card.classList.toggle("hidden", !show);

      if (show) visible++;
    });

    empty.classList.toggle("hidden", visible > 0);
  };

  search.addEventListener("input", update);
  filter.addEventListener("change", update);
}

function initialize() {
  const year = $("currentYear");

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  setupNavigation();
  setupPodcastSearch();

  loadLiveSessions();

  // Refresh every 30 seconds so the page picks up status changes.
  window.setInterval(loadLiveSessions, 30000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
