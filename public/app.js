import { EutherWormhole } from "./wormhole.js";

const basePath = normalizedBasePath();

const state = {
  wormhole: null,
  route: { label: "Offline", kind: "offline", baseUrl: "" },
  user: null,
  files: [],
  posts: [],
  users: []
};

const els = {
  route: document.querySelector("#route"),
  login: document.querySelector("#login"),
  app: document.querySelector("#app"),
  loginForm: document.querySelector("#login-form"),
  uploadForm: document.querySelector("#upload-form"),
  feedForm: document.querySelector("#feed-form"),
  feedImage: document.querySelector("#feed-image"),
  feedImageMeta: document.querySelector("#feed-image-meta"),
  library: document.querySelector("#library"),
  feed: document.querySelector("#feed"),
  adminUsers: document.querySelector("#admin-users"),
  userLabel: document.querySelector("#user-label"),
  logout: document.querySelector("#logout"),
  backupTab: document.querySelector("#backup-tab"),
  adminTab: document.querySelector("#admin-tab"),
  viewButtons: document.querySelectorAll("[data-view]"),
  views: document.querySelectorAll("[data-panel]")
};

boot();

async function boot() {
  await connectWormhole();
  await refreshMe();
  bindEvents();
  if (state.user) await refreshAll();
}

async function connectWormhole() {
  const response = await fetch(appPath("/api/config"), { cache: "no-store" });
  const config = await response.json();
  const sameOrigin = {
    name: "same-origin",
    kind: isLocalHost(location.hostname) ? "lan" : "https",
    url: `${location.origin}${basePath}`,
    priority: 50
  };
  const endpoints = config.wormhole.endpoints
    .filter((endpoint) => endpoint.url)
    .concat(sameOrigin);
  state.wormhole = new EutherWormhole({ ...config.wormhole, endpoints });
  state.route = await state.wormhole.connect();
  renderRoute();
}

async function refreshMe() {
  const response = await api("/api/me", { allowUnauthorized: true });
  if (response.ok) {
    const data = await response.json();
    state.user = data.user;
  }
  renderAuth();
}

function bindEvents() {
  els.loginForm.addEventListener("submit", onLogin);
  els.logout.addEventListener("click", onLogout);
  els.uploadForm.addEventListener("submit", onUpload);
  els.feedForm.addEventListener("submit", onFeedPost);
  els.feedForm.addEventListener("click", onFeedComposeClick);
  els.feedImage.addEventListener("change", renderFeedImageMeta);
  els.library.addEventListener("click", onLibraryClick);
  els.adminUsers.addEventListener("change", onAdminPermissionChange);
  els.viewButtons.forEach((button) => {
    button.addEventListener("click", () => showPanel(button.dataset.view));
  });
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const response = await fetch(appPath("/api/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: form.get("username"),
      password: form.get("password")
    })
  });
  if (!response.ok) return showMessage("login-message", "Login failed.");
  const data = await response.json();
  state.user = data.user;
  renderAuth();
  await refreshAll();
}

async function onLogout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  state.files = [];
  state.posts = [];
  state.users = [];
  renderAuth();
}

async function onUpload(event) {
  event.preventDefault();
  if (!can("media_backup")) return showMessage("upload-message", "Backup access is not enabled for this account.");
  const form = new FormData(event.currentTarget);
  const files = [...form.getAll("media")].filter((file) => file.size > 0);
  if (files.length === 0) return;
  showMessage("upload-message", "Backing up...");

  for (const file of files) {
    const sha256 = await sha256Hex(file);
    const params = new URLSearchParams({
      name: file.name,
      deviceId: form.get("deviceId") || "web",
      deviceName: form.get("deviceName") || "Web upload"
    });
    const response = await api(`/api/upload?${params}`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-SHA256": sha256,
        "X-Created-At": new Date(file.lastModified || Date.now()).toISOString()
      },
      body: file
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Upload failed" }));
      showMessage("upload-message", error.error || "Upload failed.");
      return;
    }
  }

  event.currentTarget.reset();
  showMessage("upload-message", "Backed up privately. Nothing was published.");
  await refreshLibrary();
}

async function onLibraryClick(event) {
  if (!can("media_backup")) return;
  const button = event.target.closest("[data-publish]");
  if (!button) return;
  const fileId = button.dataset.publish;
  const captionInput = document.querySelector(`[data-caption="${fileId}"]`);
  const response = await api("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, caption: captionInput?.value || "" })
  });
  if (!response.ok) return showMessage("library-message", "Publishing failed.");
  showMessage("library-message", "Published to the family feed.");
  await refreshAll();
}

async function onFeedPost(event) {
  event.preventDefault();
  if (!can("feed_post")) return showMessage("feed-message", "Posting is not enabled for this account.");
  const form = new FormData(event.currentTarget);
  const caption = String(form.get("caption") || "").trim();
  const image = form.get("image");
  const hasImage = image instanceof File && image.size > 0;
  if (!caption && !hasImage) return;

  showMessage("feed-message", hasImage ? "Uploading image..." : "Posting...");
  const response = hasImage ? await postFeedImage(image, caption) : await api("/api/feed/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caption })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Posting failed" }));
    return showMessage("feed-message", error.error || "Posting failed.");
  }
  event.currentTarget.reset();
  renderFeedImageMeta();
  showMessage("feed-message", "Posted to the family feed.");
  await refreshFeed();
}

async function postFeedImage(file, caption) {
  const sha256 = await sha256Hex(file);
  const params = new URLSearchParams({ name: file.name, caption });
  return api(`/api/feed/uploads?${params}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-SHA256": sha256
    },
    body: file
  });
}

function onFeedComposeClick(event) {
  const button = event.target.closest("[data-emoji]");
  if (!button) return;
  const input = els.feedForm.elements.caption;
  insertAtCursor(input, button.dataset.emoji);
}

function renderFeedImageMeta() {
  const file = els.feedImage.files?.[0];
  els.feedImageMeta.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "";
}

async function onAdminPermissionChange(event) {
  const input = event.target.closest("[data-media-backup-user]");
  if (!input) return;
  const response = await api(`/api/admin/users/${input.dataset.mediaBackupUser}/media_backup`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: input.checked })
  });
  if (!response.ok) {
    input.checked = !input.checked;
    return showMessage("admin-message", "Permission update failed.");
  }
  showMessage("admin-message", "Permission updated.");
  await refreshUsers();
}

async function refreshAll() {
  const tasks = [refreshFeed()];
  if (can("media_backup")) tasks.push(refreshLibrary());
  if (can("admin")) tasks.push(refreshUsers());
  await Promise.all(tasks);
}

async function refreshLibrary() {
  if (!can("media_backup")) {
    state.files = [];
    renderLibrary();
    return;
  }
  const response = await api("/api/library");
  if (!response.ok) return;
  state.files = (await response.json()).files;
  renderLibrary();
}

async function refreshFeed() {
  const response = await api("/api/feed");
  if (!response.ok) return;
  state.posts = (await response.json()).posts;
  renderFeed();
}

async function refreshUsers() {
  if (!can("admin")) return;
  const response = await api("/api/admin/users");
  if (!response.ok) return;
  state.users = (await response.json()).users;
  renderAdminUsers();
}

function renderRoute() {
  els.route.textContent = state.route.label;
  els.route.dataset.kind = state.route.kind;
}

function renderAuth() {
  els.login.hidden = Boolean(state.user);
  els.app.hidden = !state.user;
  els.userLabel.textContent = state.user ? state.user.displayName : "";
  els.logout.hidden = !state.user;
  els.backupTab.hidden = !can("media_backup");
  els.adminTab.hidden = !can("admin");
  if (state.user && !can("media_backup")) showPanel("feed");
  if (state.user && can("media_backup")) showPanel("backup");
}

function renderLibrary() {
  if (!can("media_backup")) {
    els.library.innerHTML = "";
    return;
  }
  if (state.files.length === 0) {
    els.library.innerHTML = `<p class="empty">No private backups yet.</p>`;
    return;
  }
  els.library.innerHTML = state.files.map((file) => {
    const isImage = file.mimeType.startsWith("image/");
    const isVideo = file.mimeType.startsWith("video/");
    const mediaUrl = appPath(`/media/library/${file.device.owner}/${file.device.id}/${file.relativePath}`);
    return `
      <article class="media-card">
        <div class="preview">
          ${isImage ? `<img src="${escapeAttr(mediaUrl)}" alt="">` : ""}
          ${isVideo ? `<video src="${escapeAttr(mediaUrl)}" controls></video>` : ""}
        </div>
        <div class="media-copy">
          <strong>${escapeHtml(file.originalName)}</strong>
          <span>${formatDate(file.createdAt)} · ${formatBytes(file.size)}</span>
          <span class="privacy">${file.published ? "Published to family feed" : "Private backup only"}</span>
          <input data-caption="${file.id}" placeholder="Caption for family feed" ${file.published ? "disabled" : ""}>
          <button data-publish="${file.id}" ${file.published ? "disabled" : ""}>Publish intentionally</button>
        </div>
      </article>`;
  }).join("");
}

function renderFeed() {
  if (state.posts.length === 0) {
    els.feed.innerHTML = `<p class="empty">No family posts yet.</p>`;
    return;
  }
  els.feed.innerHTML = state.posts.map((post) => {
    const isImage = post.media?.mimeType?.startsWith("image/");
    const isVideo = post.media?.mimeType?.startsWith("video/");
    return `
      <article class="feed-post">
        <header>
          <strong>${escapeHtml(post.post.authorName || post.post.author)}</strong>
          <time>${formatDate(post.post.createdAt)}</time>
        </header>
        ${post.post.caption ? `<p>${escapeHtml(post.post.caption)}</p>` : ""}
        ${post.media && isImage ? `<img src="${escapeAttr(appPath(post.media.url))}" alt="">` : ""}
        ${post.media && isVideo ? `<video src="${escapeAttr(appPath(post.media.url))}" controls></video>` : ""}
      </article>`;
  }).join("");
}

function renderAdminUsers() {
  if (state.users.length === 0) {
    els.adminUsers.innerHTML = `<p class="empty">No users found.</p>`;
    return;
  }
  els.adminUsers.innerHTML = state.users.map((user) => `
    <label class="admin-row">
      <span>
        <strong>${escapeHtml(user.displayName)}</strong>
        <small>${escapeHtml(user.id)}${user.permissions.admin ? " · admin" : ""}</small>
      </span>
      <span class="toggle">
        <input type="checkbox" data-media-backup-user="${escapeAttr(user.id)}" ${user.permissions.media_backup ? "checked" : ""}>
        media_backup
      </span>
    </label>
  `).join("");
}

function showPanel(panel) {
  els.views.forEach((view) => {
    view.hidden = view.dataset.panel !== panel;
  });
  els.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === panel);
  });
}

async function api(path, options = {}) {
  const response = await fetch(appPath(path), { ...options, credentials: "same-origin" });
  if (response.status === 401 && !options.allowUnauthorized) renderAuth();
  return response;
}

function can(permission) {
  return state.user?.permissions?.[permission] === true;
}

async function sha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function showMessage(id, message) {
  document.querySelector(`#${id}`).textContent = message;
}

function insertAtCursor(input, value) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${value}${input.value.slice(end)}`;
  input.selectionStart = start + value.length;
  input.selectionEnd = start + value.length;
  input.focus();
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatBytes(value) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function appPath(path) {
  if (!path.startsWith("/")) return `${basePath}/${path}`;
  return `${basePath}${path}`;
}

function normalizedBasePath() {
  const path = location.pathname;
  const marker = "/euthersync";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

function isLocalHost(hostname) {
  return hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}
