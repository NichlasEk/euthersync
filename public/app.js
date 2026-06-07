import { EutherWormhole } from "./wormhole.js";

const basePath = normalizedBasePath();

const state = {
  wormhole: null,
  route: { label: "Offline", kind: "offline", baseUrl: "" },
  user: null,
  files: [],
  posts: [],
  users: [],
  comments: {},
  feeds: [],
  activeFeedId: localStorage.getItem("euthersync-active-feed") || "family",
  preferences: {
    theme: localStorage.getItem("euthersync-theme") || "dark",
    skin: localStorage.getItem("euthersync-skin") || "classic"
  },
  feedRefreshInFlight: false,
  feedLastRefreshAt: 0,
  feedPullStartY: null,
  feedPullTriggered: false
};

const els = {
  route: document.querySelector("#route"),
  login: document.querySelector("#login"),
  app: document.querySelector("#app"),
  loginForm: document.querySelector("#login-form"),
  uploadForm: document.querySelector("#upload-form"),
  feedForm: document.querySelector("#feed-form"),
  feedImage: document.querySelector("#feed-image"),
  feedCamera: document.querySelector("#feed-camera"),
  feedCameraButton: document.querySelector("#feed-camera-button"),
  feedImageMeta: document.querySelector("#feed-image-meta"),
  library: document.querySelector("#library"),
  feed: document.querySelector("#feed"),
  feedTabs: document.querySelector("#feed-tabs"),
  feedTabsList: document.querySelector("#feed-tabs-list"),
  feedAdd: document.querySelector("#feed-add"),
  feedTitle: document.querySelector("#feed-title"),
  adminUsers: document.querySelector("#admin-users"),
  userLabel: document.querySelector("#user-label"),
  userSettings: document.querySelector("#user-settings"),
  logout: document.querySelector("#logout"),
  backupTab: document.querySelector("#backup-tab"),
  settingsAdminLink: document.querySelector("#settings-admin-link"),
  mediaViewer: document.querySelector("#media-viewer"),
  mediaViewerImage: document.querySelector("#media-viewer-image"),
  mediaViewerClose: document.querySelector("#media-viewer-close"),
  viewButtons: document.querySelectorAll("[data-view]"),
  views: document.querySelectorAll("[data-panel]")
};

boot();

async function boot() {
  applyAppearance();
  await connectWormhole();
  await refreshMe();
  bindEvents();
  if (state.user) {
    await refreshPreferences();
    await refreshAll();
  }
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
  els.userSettings.addEventListener("click", () => showPanel("settings"));
  els.uploadForm.addEventListener("submit", onUpload);
  els.feedForm.addEventListener("submit", onFeedPost);
  els.feedForm.addEventListener("click", onFeedComposeClick);
  els.feedImage.addEventListener("change", renderFeedImageMeta);
  els.feedCameraButton.addEventListener("click", onFeedCameraClick);
  els.feedCamera.addEventListener("change", onFeedCameraChange);
  els.library.addEventListener("click", onLibraryClick);
  els.feedTabs.addEventListener("click", onFeedTabsClick);
  els.feed.addEventListener("click", onFeedClick);
  els.feed.addEventListener("submit", onFeedSubmit);
  els.feed.addEventListener("scroll", onFeedScroll);
  els.feed.addEventListener("pointerdown", onFeedPointerDown);
  els.feed.addEventListener("pointermove", onFeedPointerMove);
  els.feed.addEventListener("pointerup", resetFeedPull);
  els.feed.addEventListener("pointercancel", resetFeedPull);
  els.adminUsers.addEventListener("change", onAdminPermissionChange);
  els.mediaViewer.addEventListener("click", onMediaViewerClick);
  els.mediaViewerClose.addEventListener("click", closeMediaViewer);
  document.querySelector("[data-panel='settings']").addEventListener("click", onSettingsClick);
  window.addEventListener("focus", () => refreshFeedIfActive("focus", 2500));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshFeedIfActive("visible", 2500);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMediaViewer();
  });
  window.addEventListener("euthersync-camera-posted", onAndroidCameraPosted);
  window.addEventListener("euthersync-camera-error", onAndroidCameraError);
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
  await refreshPreferences();
  await refreshAll();
}

async function onLogout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  state.files = [];
  state.posts = [];
  state.users = [];
  state.comments = {};
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

async function onFeedTabsClick(event) {
  const view = event.target.closest("[data-view]")?.dataset.view;
  if (view) return showPanel(view);

  const rename = event.target.closest("[data-rename-feed]");
  if (rename) return renameFeed(rename.dataset.renameFeed);

  const feed = event.target.closest("[data-feed-id]");
  if (feed) return selectFeed(feed.dataset.feedId);

  if (event.target.closest("#feed-add")) return createFeed();
}

async function onFeedPost(event) {
  event.preventDefault();
  if (!can("feed_post")) return showMessage("feed-message", "Posting is not enabled for this account.");
  const form = new FormData(event.currentTarget);
  const caption = String(form.get("caption") || "").trim();
  const image = form.get("image");
  const hasImage = image instanceof File && image.size > 0;
  if (!caption && !hasImage) return;

  showMessage("feed-message", hasImage ? "Preparing image..." : "Posting...");
  const response = hasImage ? await postFeedImage(image, caption) : await api(`/api/feeds/${state.activeFeedId}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caption })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Posting failed" }));
    return showMessage("feed-message", error.error || "Posting failed.");
  }
  const data = await response.json().catch(() => null);
  if (data?.post) {
    state.posts = [data.post, ...state.posts.filter((post) => post.post.id !== data.post.post.id)];
    renderFeed();
  }
  event.currentTarget.reset();
  renderFeedImageMeta();
  showMessage("feed-message", "Posted to the family feed.");
  showPanel("feed");
  refreshFeed({ fresh: true }).catch(() => {
    showMessage("feed-message", "Posted. Feed refresh will retry on next open.");
  });
}

async function onFeedCameraChange() {
  const file = els.feedCamera.files?.[0];
  els.feedCamera.value = "";
  if (!file || !can("feed_post")) return;
  const captionInput = els.feedForm.elements.caption;
  const caption = String(captionInput?.value || "").trim();
  showMessage("feed-message", "Posting camera photo...");
  const response = await postFeedImage(file, caption || "Camera photo");
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Camera post failed" }));
    return showMessage("feed-message", error.error || "Camera post failed.");
  }
  const data = await response.json().catch(() => null);
  if (data?.post) {
    state.posts = [data.post, ...state.posts.filter((post) => post.post.id !== data.post.post.id)];
    renderFeed();
  }
  if (captionInput) captionInput.value = "";
  renderFeedImageMeta();
  showPanel("feed");
  showMessage("feed-message", "Camera photo posted.");
  await refreshFeed({ fresh: true });
}

function onFeedCameraClick() {
  if (!can("feed_post")) return showMessage("feed-message", "Posting is not enabled for this account.");
  const captionInput = els.feedForm.elements.caption;
  const caption = String(captionInput?.value || "").trim() || "Camera photo";
  const params = new URLSearchParams({ name: "camera-photo.jpg", caption });
  const uploadPath = appPath(`/api/feeds/${state.activeFeedId}/uploads?${params}`);
  if (window.EutherSyncCamera?.captureFeedPhoto) {
    showMessage("feed-message", "Opening camera...");
    window.EutherSyncCamera.captureFeedPhoto(uploadPath);
    return;
  }
  els.feedCamera.click();
}

async function onAndroidCameraPosted() {
  const captionInput = els.feedForm.elements.caption;
  if (captionInput) captionInput.value = "";
  renderFeedImageMeta();
  showPanel("feed");
  showMessage("feed-message", "Camera photo posted.");
  await refreshFeed({ fresh: true });
}

function onAndroidCameraError(event) {
  showMessage("feed-message", event.detail?.message || "Camera post failed.");
}

async function postFeedImage(file, caption) {
  const sha256 = await sha256Hex(file);
  const params = new URLSearchParams({ name: file.name, caption });
  return uploadWithProgress(`/api/feeds/${state.activeFeedId}/uploads?${params}`, file, {
    "Content-Type": file.type || "application/octet-stream",
    "X-SHA256": sha256
  }, (percent) => {
    showMessage("feed-message", `Uploading image... ${percent}%`);
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

function onFeedScroll() {
  if (els.feed.scrollTop <= 0) refreshFeedIfActive("top-scroll", 1800);
}

function onFeedPointerDown(event) {
  if (els.feed.scrollTop <= 0) {
    state.feedPullStartY = event.clientY;
    state.feedPullTriggered = false;
  }
}

function onFeedPointerMove(event) {
  if (
    state.feedPullStartY !== null &&
    !state.feedPullTriggered &&
    event.clientY - state.feedPullStartY > 58
  ) {
    state.feedPullTriggered = true;
    refreshFeedIfActive("pull-top", 1200);
  }
}

function resetFeedPull() {
  state.feedPullStartY = null;
  state.feedPullTriggered = false;
}

function onSettingsClick(event) {
  const view = event.target.closest("[data-settings-view]")?.dataset.settingsView;
  if (view) return showPanel(view);
  const theme = event.target.closest("[data-theme]")?.dataset.theme;
  if (theme) return setPreference("theme", normalizeTheme(theme));
  const skin = event.target.closest("[data-skin]")?.dataset.skin;
  if (skin) return setPreference("skin", normalizeSkin(skin));
}

async function onAdminPermissionChange(event) {
  const input = event.target.closest("[data-admin-permission-user]");
  if (!input) return;
  const response = await api(`/api/admin/users/${input.dataset.adminPermissionUser}/${input.dataset.adminPermission}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: input.checked })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Permission update failed" }));
    input.checked = !input.checked;
    return showMessage("admin-message", error.error || "Permission update failed.");
  }
  showMessage("admin-message", "Permission updated.");
  await refreshUsers();
}

async function onFeedClick(event) {
  const image = event.target.closest("[data-view-image]");
  if (image) return openMediaViewer(image.dataset.viewImage);

  const toggle = event.target.closest("[data-comments-toggle]");
  if (toggle) return toggleComments(toggle.dataset.commentsToggle);

  const commentDelete = event.target.closest("[data-delete-comment]");
  if (commentDelete) return deleteComment(commentDelete.dataset.postId, commentDelete.dataset.deleteComment);

  const button = event.target.closest("[data-delete-post]");
  if (!button) return;
  if (!confirm("Delete this post?")) return;
  const response = await api(`/api/feed/posts/${button.dataset.deletePost}`, { method: "DELETE" });
  if (!response.ok) return showMessage("feed-message", "Delete failed.");
  showMessage("feed-message", "Post deleted.");
  await refreshFeed();
}

function openMediaViewer(url) {
  els.mediaViewerImage.src = url;
  els.mediaViewer.hidden = false;
  document.body.classList.add("viewer-open");
}

function closeMediaViewer() {
  if (els.mediaViewer.hidden) return;
  els.mediaViewer.hidden = true;
  els.mediaViewerImage.removeAttribute("src");
  document.body.classList.remove("viewer-open");
}

function onMediaViewerClick(event) {
  if (event.target === els.mediaViewer) closeMediaViewer();
}

async function onFeedSubmit(event) {
  const form = event.target.closest("[data-comment-form]");
  if (!form) return;
  event.preventDefault();
  const postId = form.dataset.commentForm;
  const input = form.elements.comment;
  const text = String(input?.value || "").trim();
  if (!text) return;
  const response = await api(`/api/feed/posts/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Comment failed" }));
    return showMessage("feed-message", error.error || "Comment failed.");
  }
  const data = await response.json();
  const entry = state.comments[postId] || { open: true, comments: [] };
  entry.open = true;
  entry.loaded = true;
  entry.comments = [...entry.comments, data.comment];
  state.comments[postId] = entry;
  updatePostCommentCount(postId, data.commentCount ?? entry.comments.length);
  input.value = "";
  renderFeed();
}

async function refreshAll() {
  await refreshFeeds();
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

async function refreshFeed(options = {}) {
  const path = options.fresh
    ? `/api/feeds/${state.activeFeedId}/posts?ts=${Date.now()}`
    : `/api/feeds/${state.activeFeedId}/posts`;
  const response = await api(path, { cache: "no-store" });
  if (!response.ok) return;
  state.posts = (await response.json()).posts;
  const ids = new Set(state.posts.map((post) => post.post.id));
  Object.keys(state.comments).forEach((postId) => {
    if (!ids.has(postId)) delete state.comments[postId];
  });
  renderFeed();
}

async function refreshFeeds() {
  const response = await api("/api/feeds", { cache: "no-store" });
  if (!response.ok) return;
  state.feeds = (await response.json()).feeds;
  if (!state.feeds.some((feed) => feed.id === state.activeFeedId)) {
    state.activeFeedId = "family";
    localStorage.setItem("euthersync-active-feed", state.activeFeedId);
  }
  renderFeedTabs();
}

async function selectFeed(feedId) {
  state.activeFeedId = normalizeFeedId(feedId);
  localStorage.setItem("euthersync-active-feed", state.activeFeedId);
  state.comments = {};
  renderFeedTabs();
  showPanel("feed");
  await refreshFeed({ fresh: true });
}

async function createFeed() {
  const name = prompt("Feed name");
  if (!name?.trim()) return;
  const response = await api("/api/feeds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) return showMessage("feed-message", "Feed could not be created.");
  const data = await response.json();
  state.feeds = data.feeds;
  await selectFeed(data.feed.id);
}

async function renameFeed(feedId) {
  const feed = state.feeds.find((entry) => entry.id === feedId);
  if (!feed) return;
  const name = prompt("Feed name", feed.name);
  if (!name?.trim() || name.trim() === feed.name) return;
  const response = await api(`/api/feeds/${feedId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) return showMessage("feed-message", "Feed could not be renamed.");
  state.feeds = (await response.json()).feeds;
  renderFeedTabs();
}

async function toggleComments(postId) {
  const entry = state.comments[postId] || { open: false, loaded: false, comments: [] };
  entry.open = !entry.open;
  state.comments[postId] = entry;
  renderFeed();
  if (entry.open && !entry.loaded) await loadComments(postId);
}

async function loadComments(postId) {
  const entry = state.comments[postId] || { open: true, loaded: false, comments: [] };
  entry.loading = true;
  state.comments[postId] = entry;
  renderFeed();
  const response = await api(`/api/feed/posts/${postId}/comments`);
  entry.loading = false;
  entry.loaded = response.ok;
  entry.comments = response.ok ? (await response.json()).comments : [];
  state.comments[postId] = entry;
  updatePostCommentCount(postId, entry.comments.length);
  renderFeed();
}

async function deleteComment(postId, commentId) {
  if (!confirm("Delete this comment?")) return;
  const response = await api(`/api/feed/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
  if (!response.ok) return showMessage("feed-message", "Comment delete failed.");
  const data = await response.json().catch(() => ({}));
  const entry = state.comments[postId];
  if (entry) entry.comments = entry.comments.filter((comment) => comment.id !== commentId);
  updatePostCommentCount(postId, data.commentCount ?? entry?.comments?.length ?? 0);
  renderFeed();
}

function updatePostCommentCount(postId, count) {
  state.posts = state.posts.map((post) => (
    post.post.id === postId ? { ...post, commentCount: count } : post
  ));
}

async function refreshFeedIfActive(_reason, minIntervalMs = 1500) {
  if (!state.user || state.feedRefreshInFlight || document.querySelector("[data-panel='feed']").hidden) return;
  const now = Date.now();
  if (now - state.feedLastRefreshAt < minIntervalMs) return;
  state.feedLastRefreshAt = now;
  state.feedRefreshInFlight = true;
  const wasAtTop = els.feed.scrollTop <= 0;
  try {
    await refreshFeed({ fresh: true });
    if (wasAtTop) els.feed.scrollTop = 0;
  } finally {
    state.feedRefreshInFlight = false;
  }
}

async function refreshPreferences() {
  const response = await api("/api/user/preferences");
  if (!response.ok) {
    applyAppearance();
    return;
  }
  const preferences = await response.json();
  state.preferences.theme = normalizeTheme(preferences.theme);
  state.preferences.skin = normalizeSkin(preferences.skin);
  localStorage.setItem("euthersync-theme", state.preferences.theme);
  localStorage.setItem("euthersync-skin", state.preferences.skin);
  applyAppearance();
}

async function setPreference(key, value) {
  state.preferences[key] = value;
  localStorage.setItem(`euthersync-${key}`, value);
  applyAppearance();
  renderSettings();
  const response = await api("/api/user/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.preferences)
  });
  showMessage("settings-message", response.ok ? "Saved." : "Settings save failed.");
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
  els.feedForm.hidden = Boolean(state.user) && !can("feed_post");
  els.settingsAdminLink.hidden = !can("admin");
  els.userSettings.hidden = !state.user;
  if (state.user) showPanel("feed");
  renderFeedTabs();
  renderSettings();
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
  const activeFeed = currentFeed();
  if (state.posts.length === 0) {
    els.feed.innerHTML = `<p class="empty">No posts in ${escapeHtml(activeFeed?.name || "this feed")} yet.</p>`;
    return;
  }
  els.feed.innerHTML = state.posts.map((post) => {
    const isImage = post.media?.mimeType?.startsWith("image/");
    const isVideo = post.media?.mimeType?.startsWith("video/");
    const imageUrl = post.media?.url;
    const fullImageUrl = post.media?.originalUrl || post.media?.url;
    const canDelete = post.post.author === state.user?.id || can("admin");
    return `
      <article class="feed-post">
        <header>
          <strong>${escapeHtml(post.post.authorName || post.post.author)}</strong>
          <div class="post-actions">
            <time>${formatDate(post.post.createdAt)}</time>
            ${canDelete ? `<button type="button" data-delete-post="${escapeAttr(post.post.id)}">Delete</button>` : ""}
          </div>
        </header>
        ${post.post.caption ? `<p>${escapeHtml(post.post.caption)}</p>` : ""}
        ${renderComments(post)}
        ${post.media && isImage ? `
          <button class="feed-image-button" type="button" data-view-image="${escapeAttr(appPath(fullImageUrl))}">
            <img src="${escapeAttr(appPath(imageUrl))}" alt="" loading="lazy" decoding="async">
          </button>` : ""}
        ${post.media && isVideo ? `<video src="${escapeAttr(appPath(post.media.url))}" controls preload="metadata"></video>` : ""}
      </article>`;
  }).join("");
}

function renderFeedTabs() {
  els.feedTitle.textContent = currentFeed()?.name || "Family feed";
  els.feedTabsList.innerHTML = state.feeds.map((feed) => {
    const canRename = !feed.system && (feed.createdBy === state.user?.id || can("admin"));
    return `
      <span class="feed-tab-item">
        <button
          type="button"
          data-feed-id="${escapeAttr(feed.id)}"
          class="${feed.id === state.activeFeedId ? "active" : ""}"
        >${escapeHtml(feed.name)}</button>
        ${canRename ? `<button class="feed-rename" type="button" data-rename-feed="${escapeAttr(feed.id)}" aria-label="Rename ${escapeAttr(feed.name)}">Edit</button>` : ""}
      </span>`;
  }).join("");
}

function currentFeed() {
  return state.feeds.find((feed) => feed.id === state.activeFeedId) || state.feeds.find((feed) => feed.id === "family");
}

function renderComments(post) {
  const postId = post.post.id;
  const entry = state.comments[postId] || { open: false, loaded: false, loading: false, comments: [] };
  const count = post.commentCount ?? entry.comments.length;
  return `
    <section class="comments" data-comments="${escapeAttr(postId)}">
      <button class="comments-toggle" type="button" data-comments-toggle="${escapeAttr(postId)}">
        ${entry.open ? "Hide comments" : "Comments"} · ${count}
      </button>
      ${entry.open ? `
        <div class="comments-panel">
          ${entry.loading ? `<p class="comment-empty">Loading comments...</p>` : ""}
          ${entry.loaded && entry.comments.length === 0 ? `<p class="comment-empty">No comments yet.</p>` : ""}
          ${entry.comments.map((comment) => renderComment(postId, comment)).join("")}
          ${can("feed_post") ? `
            <form class="comment-form" data-comment-form="${escapeAttr(postId)}">
              <input name="comment" maxlength="1000" placeholder="Write a comment" autocomplete="off">
              <button type="submit">Post</button>
            </form>` : ""}
        </div>` : ""}
    </section>`;
}

function renderComment(postId, comment) {
  const canDelete = comment.author === state.user?.id || can("admin");
  return `
    <article class="comment">
      <header>
        <strong>${escapeHtml(comment.authorName || comment.author)}</strong>
        <div class="post-actions">
          <time>${formatDate(comment.createdAt)}</time>
          ${canDelete ? `
            <button
              type="button"
              data-post-id="${escapeAttr(postId)}"
              data-delete-comment="${escapeAttr(comment.id)}"
            >Delete</button>` : ""}
        </div>
      </header>
      <p>${escapeHtml(comment.text)}</p>
    </article>`;
}

function renderAdminUsers() {
  if (state.users.length === 0) {
    els.adminUsers.innerHTML = `<p class="empty">No users found.</p>`;
    return;
  }
  els.adminUsers.innerHTML = state.users.map((user) => `
    <article class="admin-row">
      <span>
        <strong>${escapeHtml(user.displayName)}</strong>
        <small>${escapeHtml(user.id)}${user.permissions.admin ? " · admin" : ""}</small>
      </span>
      <div class="permission-toggles">
        ${permissionToggle(user, "media_backup", "File sync")}
        ${permissionToggle(user, "feed_post", "Post feed")}
        ${permissionToggle(user, "admin", "Admin")}
      </div>
    </article>
  `).join("");
}

function permissionToggle(user, permission, label) {
  return `
    <label class="toggle">
      <input
        type="checkbox"
        data-admin-permission-user="${escapeAttr(user.id)}"
        data-admin-permission="${escapeAttr(permission)}"
        ${user.permissions[permission] ? "checked" : ""}
        ${user.id === state.user?.id && permission === "admin" ? "disabled" : ""}
      >
      ${escapeHtml(label)}
    </label>`;
}

function showPanel(panel) {
  els.views.forEach((view) => {
    view.hidden = view.dataset.panel !== panel;
  });
  els.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === panel);
  });
  els.userSettings.classList.toggle("active", panel === "settings");
  renderFeedTabs();
  if (can("admin") && panel === "admin") refreshUsers();
  if (panel === "feed") refreshFeedIfActive("show", 0);
  if (panel === "settings") renderSettings();
}

function renderSettings() {
  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === state.preferences.theme);
  });
  document.querySelectorAll("[data-skin]").forEach((button) => {
    button.classList.toggle("active", button.dataset.skin === state.preferences.skin);
  });
}

function normalizeTheme(value) {
  return value === "light" || value === "royal-apothic" ? value : "dark";
}

function normalizeSkin(value) {
  return value === "glass" || value === "arcade" ? value : "classic";
}

function normalizeFeedId(value) {
  return String(value || "family").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "family";
}

function applyAppearance() {
  state.preferences.theme = normalizeTheme(state.preferences.theme);
  state.preferences.skin = normalizeSkin(state.preferences.skin);
  document.body.dataset.theme = state.preferences.theme;
  document.body.dataset.skin = state.preferences.skin;
  document.documentElement.style.colorScheme = state.preferences.theme === "light" ? "light" : "dark";
}

async function api(path, options = {}) {
  const response = await fetch(appPath(path), { ...options, credentials: "same-origin" });
  if (response.status === 401 && !options.allowUnauthorized) renderAuth();
  return response;
}

function uploadWithProgress(path, body, headers, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", appPath(path));
    xhr.withCredentials = true;
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return showMessage("feed-message", "Uploading image...");
      onProgress(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
    });
    xhr.upload.addEventListener("load", () => {
      showMessage("feed-message", "Processing image...");
    });
    xhr.addEventListener("load", () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: async () => JSON.parse(xhr.responseText || "{}")
      });
    });
    xhr.addEventListener("error", () => {
      resolve({
        ok: false,
        status: 0,
        json: async () => ({ error: "Upload failed" })
      });
    });
    xhr.send(body);
  });
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
