import { createServer } from "node:http";
import { randomUUID, randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(projectRoot, "public");

const config = await loadConfig();
const paths = {
  users: () => path.join(config.storagePath, "users"),
  sessions: () => path.join(config.storagePath, "config", "sessions.json"),
  library: () => path.join(config.storagePath, "library"),
  libraryUser: (userId) => path.join(config.storagePath, "library", safeId(userId)),
  device: (userId, deviceId) => path.join(config.storagePath, "library", safeId(userId), safeId(deviceId)),
  feedPosts: () => path.join(config.storagePath, "feed", "posts"),
  feedMedia: () => path.join(config.storagePath, "feed", "media"),
  feedComments: () => path.join(config.storagePath, "feed", "comments"),
  feeds: () => path.join(config.storagePath, "feed", "feeds.json")
};
await ensureStorage(config.storagePath);
if (!config.hostUsersPath) {
  await ensureDefaultUser(config);
} else {
  console.log(`[euthersync] users: ${config.hostUsersPath}`);
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error("[euthersync] request failed", error);
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[euthersync] listening on http://${config.host}:${config.port}`);
  console.log(`[euthersync] storage: ${config.storagePath}`);
});

async function loadConfig() {
  const configPath = process.env.EUTHERSYNC_CONFIG || path.join(projectRoot, "config.json");
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const storagePath = path.resolve(
    process.env.EUTHERSYNC_STORAGE ||
      fileConfig.storagePath ||
      path.join(projectRoot, "data", "euther-sync")
  );

  return {
    host: process.env.EUTHERSYNC_HOST || fileConfig.host || "0.0.0.0",
    port: Number(process.env.EUTHERSYNC_PORT || fileConfig.port || 3000),
    publicUrl: process.env.EUTHERSYNC_PUBLIC_URL || fileConfig.publicUrl || "https://example.com",
    localUrl: process.env.EUTHERSYNC_LOCAL_URL || fileConfig.localUrl || "http://eutheroxide.local:3000",
    imageMagickBin: process.env.EUTHERSYNC_IMAGE_MAGICK_BIN || fileConfig.imageMagickBin || "magick",
    hostUsersPath: process.env.EUTHERSYNC_HOST_USERS || fileConfig.hostUsersPath || "",
    hostVerifyBin:
      process.env.EUTHERSYNC_HOST_VERIFY_BIN ||
      fileConfig.hostVerifyBin ||
      path.resolve(projectRoot, "..", "..", "target", "release", "euther-oxide"),
    storagePath,
    sessionSecret: process.env.EUTHERSYNC_SESSION_SECRET || fileConfig.sessionSecret || "change-me",
    defaultUser: {
      id: process.env.EUTHERSYNC_DEFAULT_USER || fileConfig.defaultUser?.id || "nichlas",
      displayName: process.env.EUTHERSYNC_DEFAULT_NAME || fileConfig.defaultUser?.displayName || "Nichlas",
      password:
        process.env.EUTHERSYNC_DEFAULT_PASSWORD ||
        fileConfig.defaultUser?.password ||
        "change-me-now",
      permissions: normalizePermissions(fileConfig.defaultUser?.permissions || {
        feed_read: true,
        feed_post: true,
        media_backup: true,
        admin: true
      })
    }
  };
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  logRequest(req, url);

  if (req.method === "GET" && url.pathname === "/health") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return json(res, 200, {
      ok: true,
      app: "EutherSync",
      route: "server",
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      wormhole: {
        preferLocal: true,
        showRouteStatus: true,
        endpoints: [
          { name: "local", kind: "lan", url: config.localUrl, priority: 1 },
          { name: "public", kind: "https", url: config.publicUrl, priority: 2 },
          { name: "same-origin", kind: "current", url: "", priority: 99 }
        ]
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
  if (req.method === "POST" && url.pathname === "/api/logout") return logout(res);

  const user = await currentUser(req);
  if (url.pathname.startsWith("/api/") && !user) return json(res, 401, { error: "Login required" });

  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user });
  if (req.method === "GET" && url.pathname === "/api/admin/users") return adminUsers(res, user);
  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/users/")) return adminPermissions(req, res, url, user);
  if (req.method === "GET" && url.pathname === "/api/user/preferences") return userPreferences(res, user);
  if (req.method === "POST" && url.pathname === "/api/user/preferences") return saveUserPreferences(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/upload") return upload(req, res, url, user);
  if (req.method === "GET" && url.pathname === "/api/library") return library(res, user);
  if (req.method === "POST" && url.pathname === "/api/publish") return publish(req, res, user);
  if (req.method === "GET" && url.pathname === "/api/feeds") return feeds(res, user);
  if (req.method === "POST" && url.pathname === "/api/feeds") return createFeed(req, res, user);
  if (req.method === "PATCH" && url.pathname.startsWith("/api/feeds/")) return renameFeed(req, res, url, user);
  if (req.method === "GET" && url.pathname.startsWith("/api/feeds/") && url.pathname.endsWith("/posts")) {
    return feed(res, user, feedIdFromFeedRoute(url));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/feeds/") && url.pathname.endsWith("/posts")) {
    return createFeedPost(req, res, user, feedIdFromFeedRoute(url));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/feeds/") && url.pathname.endsWith("/uploads")) {
    return createFeedUpload(req, res, url, user, feedIdFromFeedRoute(url));
  }
  if (req.method === "POST" && url.pathname === "/api/feed/posts") return createFeedPost(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/feed/uploads") return createFeedUpload(req, res, url, user);
  if (url.pathname.includes("/comments")) {
    if (req.method === "GET" && url.pathname.startsWith("/api/feed/posts/")) return feedComments(res, url, user);
    if (req.method === "POST" && url.pathname.startsWith("/api/feed/posts/")) return createFeedComment(req, res, url, user);
    if (req.method === "DELETE" && url.pathname.startsWith("/api/feed/posts/")) return deleteFeedComment(res, url, user);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/feed/posts/")) return deleteFeedPost(res, url, user);
  if (req.method === "GET" && url.pathname === "/api/feed") return feed(res, user, "family");
  if (req.method === "GET" && url.pathname.startsWith("/media/")) return media(req, res, url, user);

  return staticFile(res, url.pathname);
}

async function login(req, res) {
  const body = await readJson(req);
  const user = await getUser(body.username || "");
  if (!user || !(await verifyUserPassword(body.password || "", user))) {
    return json(res, 401, { error: "Invalid username or password" });
  }

  const token = randomBytes(32).toString("hex");
  const sessions = await readJsonFile(paths.sessions(), {});
  sessions[token] = { userId: user.id, createdAt: new Date().toISOString() };
  await writeJsonFile(paths.sessions(), sessions);

  res.setHeader("Set-Cookie", cookie("euthersync_session", token));
  return json(res, 200, { user: publicUser(user) });
}

async function logout(res) {
  res.setHeader("Set-Cookie", cookie("euthersync_session", "", 0));
  return json(res, 200, { ok: true });
}

async function upload(req, res, url, user) {
  if (!hasPermission(user, "media_backup")) return json(res, 403, { error: "media_backup permission required" });

  const deviceId = safeId(url.searchParams.get("deviceId") || req.headers["x-device-id"] || "web");
  const deviceName = String(url.searchParams.get("deviceName") || req.headers["x-device-name"] || "Web upload");
  const originalName = cleanFileName(url.searchParams.get("name") || req.headers["x-file-name"] || "upload.bin");
  const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
  const expectedSha = String(req.headers["x-sha256"] || "").toLowerCase();
  const createdAt = String(req.headers["x-created-at"] || new Date().toISOString());

  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    return json(res, 400, { error: "X-SHA256 header is required" });
  }

  const manifest = await readManifest(user.id, deviceId, deviceName);
  const duplicate = manifest.files.find((file) => file.sha256 === expectedSha);
  if (duplicate) return json(res, 200, { duplicate: true, file: duplicate });

  const kind = mimeType.startsWith("video/") ? "videos" : "photos";
  const now = new Date();
  const relativePath = path.posix.join(
    kind,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${randomUUID()}-${originalName}`
  );
  const finalPath = path.join(paths.device(user.id, deviceId), relativePath);
  const tmpPath = `${finalPath}.uploading`;
  await mkdir(path.dirname(finalPath), { recursive: true });

  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmpPath);
    req.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    req.pipe(out);
  });

  const actualSha = hash.digest("hex");
  if (actualSha !== expectedSha) {
    await rm(tmpPath, { force: true });
    return json(res, 400, { error: "SHA256 verification failed", expected: expectedSha, actual: actualSha });
  }

  await rename(tmpPath, finalPath);
  const file = {
    id: randomUUID(),
    originalName,
    relativePath,
    sha256: actualSha,
    size,
    mimeType,
    createdAt,
    uploadedAt: new Date().toISOString(),
    backedUp: true,
    published: false
  };
  manifest.files.push(file);
  await writeManifest(user.id, deviceId, manifest);
  return json(res, 201, { file });
}

async function library(res, user) {
  if (!hasPermission(user, "media_backup")) return json(res, 403, { error: "media_backup permission required" });

  const root = paths.libraryUser(user.id);
  const entries = [];
  try {
    const deviceDirs = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }));
    for (const dir of deviceDirs.filter((entry) => entry.isDirectory())) {
      const manifest = await readJsonFile(path.join(root, dir.name, "manifest.json"), null);
      if (!manifest) continue;
      for (const file of manifest.files) entries.push({ ...file, device: manifest.device });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return json(res, 200, { files: entries });
}

async function publish(req, res, user) {
  if (!hasPermission(user, "feed_post")) return json(res, 403, { error: "feed_post permission required" });
  if (!hasPermission(user, "media_backup")) return json(res, 403, { error: "media_backup permission required" });

  const body = await readJson(req);
  const fileId = safeId(body.fileId || "");
  const caption = String(body.caption || "").trim().slice(0, 500);
  if (!fileId) return json(res, 400, { error: "fileId is required" });

  const found = await findUserFile(user.id, fileId);
  if (!found) return json(res, 404, { error: "File not found" });

  found.file.published = true;
  await writeManifest(user.id, found.deviceId, found.manifest);

  const postId = randomUUID();
  const sourcePath = path.join(paths.device(user.id, found.deviceId), found.file.relativePath);
  const extension = path.extname(found.file.originalName) || path.extname(found.file.relativePath) || ".bin";
  const originalMediaName = `${postId}-original${extension}`;
  const originalMediaPath = path.join(paths.feedMedia(), originalMediaName);
  await mkdir(paths.feedMedia(), { recursive: true });
  await copyFile(sourcePath, originalMediaPath);
  const variants = found.file.mimeType.startsWith("image/")
    ? await createFeedImageVariants(originalMediaPath, postId)
    : { feedUrl: `/media/feed/${originalMediaName}`, thumbnailUrl: null };

  const post = {
    post: {
      id: postId,
      author: user.id,
      authorName: user.displayName,
      feedId: "family",
      caption,
      visibility: "family",
      createdAt: new Date().toISOString()
    },
    media: {
      fileId: found.file.id,
      originalName: found.file.originalName,
      mimeType: found.file.mimeType,
      url: variants.feedUrl,
      originalUrl: `/media/feed/${originalMediaName}`,
      thumbnail: variants.thumbnailUrl
    }
  };
  await writeJsonFile(path.join(paths.feedPosts(), `${postId}.json`), post);
  return json(res, 201, { post });
}

async function feeds(res, user) {
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });
  return json(res, 200, { feeds: await readFeeds() });
}

async function createFeed(req, res, user) {
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });
  const body = await readJson(req);
  const name = cleanFeedName(body.name);
  if (!name) return json(res, 400, { error: "Feed name is required" });
  const existing = await readFeeds();
  const feed = {
    id: uniqueFeedId(name, existing),
    name,
    createdBy: user.id,
    createdAt: new Date().toISOString(),
    system: false
  };
  const next = [...existing, feed];
  await writeFeeds(next);
  return json(res, 201, { feed, feeds: next });
}

async function renameFeed(req, res, url, user) {
  const feedId = feedIdFromFeedRoute(url);
  const existing = await readFeeds();
  const feed = existing.find((entry) => entry.id === feedId);
  if (!feed) return json(res, 404, { error: "Feed not found" });
  if (feed.system) return json(res, 403, { error: "System feeds cannot be renamed" });
  if (feed.createdBy !== user.id && !hasPermission(user, "admin")) {
    return json(res, 403, { error: "Only the feed creator can rename this feed" });
  }
  const body = await readJson(req);
  const name = cleanFeedName(body.name);
  if (!name) return json(res, 400, { error: "Feed name is required" });
  feed.name = name;
  feed.updatedAt = new Date().toISOString();
  await writeFeeds(existing);
  return json(res, 200, { feed, feeds: existing });
}

async function feed(res, user, feedId = "family") {
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });
  const selectedFeed = await findFeed(feedId);
  if (!selectedFeed) return json(res, 404, { error: "Feed not found" });

  let posts = [];
  try {
    const names = await import("node:fs/promises").then((fs) => fs.readdir(paths.feedPosts()));
    posts = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile(path.join(paths.feedPosts(), name), null))
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  posts = posts
    .filter(Boolean)
    .filter((post) => normalizeFeedId(post.post?.feedId || "family") === selectedFeed.id)
    .sort((a, b) => String(b.post.createdAt).localeCompare(String(a.post.createdAt)));
  posts = await Promise.all(posts.map(async (post) => ({
    ...post,
    commentCount: await feedCommentCount(post.post.id)
  })));
  return json(res, 200, { posts });
}

async function userPreferences(res, user) {
  return json(res, 200, await readUserPreferences(user));
}

async function saveUserPreferences(req, res, user) {
  const body = await readJson(req);
  const preferences = normalizeUserPreferences(body);
  try {
    await writeUserPreferences(user, preferences);
  } catch (error) {
    console.error("[euthersync] settings write failed", error);
    return json(res, 500, { error: "Settings TOML save failed" });
  }
  return json(res, 200, preferences);
}

async function createFeedPost(req, res, user, routeFeedId = "family") {
  if (!hasPermission(user, "feed_post")) return json(res, 403, { error: "feed_post permission required" });
  const body = await readJson(req);
  const selectedFeed = await findFeed(routeFeedId || body.feedId || "family");
  if (!selectedFeed) return json(res, 404, { error: "Feed not found" });
  const caption = String(body.caption || "").trim().slice(0, 500);
  if (!caption) return json(res, 400, { error: "Caption is required" });

  const post = {
    post: {
      id: randomUUID(),
      author: user.id,
      authorName: user.displayName,
      feedId: selectedFeed.id,
      caption,
      visibility: "family",
      createdAt: new Date().toISOString()
    },
    media: null
  };
  await writeJsonFile(path.join(paths.feedPosts(), `${post.post.id}.json`), post);
  return json(res, 201, { post });
}

async function createFeedUpload(req, res, url, user, routeFeedId = "family") {
  if (!hasPermission(user, "feed_post")) return json(res, 403, { error: "feed_post permission required" });

  const selectedFeed = await findFeed(routeFeedId || url.searchParams.get("feedId") || "family");
  if (!selectedFeed) return json(res, 404, { error: "Feed not found" });
  const caption = String(url.searchParams.get("caption") || "").trim().slice(0, 500);
  const originalName = cleanFileName(url.searchParams.get("name") || req.headers["x-file-name"] || "feed-image.jpg");
  const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
  const expectedSha = String(req.headers["x-sha256"] || "").toLowerCase();
  if (!mimeType.startsWith("image/")) return json(res, 400, { error: "Only image uploads are supported for feed posts" });
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) return json(res, 400, { error: "X-SHA256 header is required" });

  const postId = randomUUID();
  const extension = path.extname(originalName) || extensionForMime(mimeType) || ".jpg";
  const originalMediaName = `${postId}-original${extension}`;
  const originalMediaPath = path.join(paths.feedMedia(), originalMediaName);
  const tmpPath = `${originalMediaPath}.uploading`;
  await mkdir(paths.feedMedia(), { recursive: true });

  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmpPath);
    req.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    req.pipe(out);
  });

  const actualSha = hash.digest("hex");
  if (actualSha !== expectedSha) {
    await rm(tmpPath, { force: true });
    return json(res, 400, { error: "SHA256 verification failed", expected: expectedSha, actual: actualSha });
  }

  await rename(tmpPath, originalMediaPath);
  const variants = await createFeedImageVariants(originalMediaPath, postId);
  const post = {
    post: {
      id: postId,
      author: user.id,
      authorName: user.displayName,
      feedId: selectedFeed.id,
      caption,
      visibility: "family",
      createdAt: new Date().toISOString()
    },
    media: {
      fileId: postId,
      originalName,
      mimeType,
      size,
      sha256: actualSha,
      url: variants.feedUrl,
      originalUrl: `/media/feed/${originalMediaName}`,
      thumbnail: variants.thumbnailUrl
    }
  };
  await writeJsonFile(path.join(paths.feedPosts(), `${postId}.json`), post);
  return json(res, 201, { post });
}

async function deleteFeedPost(res, url, user) {
  const parts = url.pathname.split("/").filter(Boolean);
  const postId = safeId(parts[3] || "");
  if (parts.length !== 4 || !postId) return json(res, 400, { error: "Use /api/feed/posts/:postId" });

  const postPath = path.join(paths.feedPosts(), `${postId}.json`);
  const post = await readJsonFile(postPath, null);
  if (!post) return json(res, 404, { error: "Post not found" });
  if (post.post?.author !== user.id && !hasPermission(user, "admin")) {
    return json(res, 403, { error: "Only the author can delete this post" });
  }

  await deleteFeedMedia(post.media);
  await rm(postPath, { force: true });
  await rm(feedCommentsPath(postId), { force: true });
  return json(res, 200, { ok: true });
}

async function feedComments(res, url, user) {
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });
  const { postId, commentId, ok } = parseCommentRoute(url);
  if (!ok || commentId) return json(res, 400, { error: "Use /api/feed/posts/:postId/comments" });
  if (!(await feedPostExists(postId))) return json(res, 404, { error: "Post not found" });
  return json(res, 200, { comments: await readFeedComments(postId) });
}

async function createFeedComment(req, res, url, user) {
  if (!hasPermission(user, "feed_post")) return json(res, 403, { error: "feed_post permission required" });
  const { postId, commentId, ok } = parseCommentRoute(url);
  if (!ok || commentId) return json(res, 400, { error: "Use /api/feed/posts/:postId/comments" });
  if (!(await feedPostExists(postId))) return json(res, 404, { error: "Post not found" });
  const body = await readJson(req);
  const text = String(body.text || "").trim().slice(0, 1000);
  if (!text) return json(res, 400, { error: "Comment text is required" });
  const comments = await readFeedComments(postId);
  const comment = {
    id: randomUUID(),
    author: user.id,
    authorName: user.displayName,
    text,
    createdAt: new Date().toISOString()
  };
  comments.push(comment);
  await writeFeedComments(postId, comments);
  return json(res, 201, { comment, commentCount: comments.length });
}

async function deleteFeedComment(res, url, user) {
  const { postId, commentId, ok } = parseCommentRoute(url);
  if (!ok || !commentId) return json(res, 400, { error: "Use /api/feed/posts/:postId/comments/:commentId" });
  if (!(await feedPostExists(postId))) return json(res, 404, { error: "Post not found" });
  const comments = await readFeedComments(postId);
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment) return json(res, 404, { error: "Comment not found" });
  if (comment.author !== user.id && !hasPermission(user, "admin")) {
    return json(res, 403, { error: "Only the comment author can delete this comment" });
  }
  const next = comments.filter((entry) => entry.id !== commentId);
  await writeFeedComments(postId, next);
  return json(res, 200, { ok: true, commentCount: next.length });
}

async function adminUsers(res, user) {
  if (!hasPermission(user, "admin")) return json(res, 403, { error: "admin permission required" });
  if (config.hostUsersPath) {
    return json(res, 200, { users: (await getUsers()).map(publicUser) });
  }
  const names = await import("node:fs/promises").then((fs) => fs.readdir(paths.users()));
  const users = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile(path.join(paths.users(), name), null))
  );
  return json(res, 200, { users: users.filter(Boolean).map(publicUser) });
}

async function adminPermissions(req, res, url, user) {
  if (!hasPermission(user, "admin")) return json(res, 403, { error: "admin permission required" });
  const parts = url.pathname.split("/").filter(Boolean);
  const userId = safeId(parts[3] || "");
  const permission = parts[4];
  if (parts.length !== 5 || !["media_backup", "feed_post", "admin"].includes(permission)) {
    return json(res, 400, { error: "Use /api/admin/users/:userId/:permission" });
  }

  const target = await getUser(userId);
  if (!target) return json(res, 404, { error: "User not found" });

  const body = await readJson(req);
  if (config.hostUsersPath) {
    try {
      await writeHostUserPermission(userId, permission, Boolean(body.enabled));
    } catch (error) {
      return json(res, 400, { error: error.message || "Permission update failed" });
    }
    return json(res, 200, { user: publicUser(await getUser(userId)) });
  }

  target.permissions = normalizePermissions(target.permissions);
  target.permissions[permission] = Boolean(body.enabled);
  await writeJsonFile(path.join(paths.users(), `${target.id}.json`), target);
  return json(res, 200, { user: publicUser(target) });
}

async function media(req, res, url, user) {
  if (!user) return json(res, 401, { error: "Login required" });
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });
  const parts = url.pathname.split("/").filter(Boolean);
  let filePath;
  if (parts[1] === "library" && parts.length >= 5) {
    if (!hasPermission(user, "media_backup")) return json(res, 403, { error: "media_backup permission required" });
    const userId = safeId(parts[2]);
    if (userId !== safeId(user.id)) return json(res, 403, { error: "Forbidden" });
    filePath = path.join(paths.library(), userId, safeId(parts[3]), ...parts.slice(4).map(cleanFileName));
  } else if (parts[1] === "feed" && parts[2]) {
    filePath = path.join(paths.feedMedia(), cleanFileName(parts[2]));
  }
  if (!filePath || !filePath.startsWith(config.storagePath)) return json(res, 404, { error: "Not found" });
  return streamFile(res, filePath);
}

async function staticFile(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicRoot, requestPath));
  if (!filePath.startsWith(publicRoot)) return json(res, 404, { error: "Not found" });
  return streamFile(res, filePath);
}

async function streamFile(res, filePath) {
  try {
    const info = await stat(filePath);
    res.writeHead(200, {
      "Content-Length": info.size,
      "Content-Type": mime(filePath),
      "Cache-Control": "private, max-age=60"
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    throw error;
  }
}

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie || "").euthersync_session;
  if (!token) return null;
  const sessions = await readJsonFile(paths.sessions(), {});
  const session = sessions[token];
  if (!session) return null;
  const user = await getUser(session.userId);
  return user ? publicUser(user) : null;
}

async function getUser(id) {
  if (config.hostUsersPath) {
    const lookupId = String(id || "").trim().toLowerCase();
    return (await getUsers()).find((user) => user.id.toLowerCase() === lookupId) || null;
  }
  return readJsonFile(path.join(paths.users(), `${safeId(id)}.json`), null);
}

async function getUsers() {
  if (!config.hostUsersPath) {
    const names = await import("node:fs/promises").then((fs) => fs.readdir(paths.users()));
    const users = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile(path.join(paths.users(), name), null))
    );
    return users.filter(Boolean);
  }

  return parseHostUsersToml(await readFile(config.hostUsersPath, "utf8"));
}

async function ensureDefaultUser() {
  const userPath = path.join(paths.users(), `${safeId(config.defaultUser.id)}.json`);
  try {
    await stat(userPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const salt = randomBytes(16).toString("hex");
    const user = {
      id: safeId(config.defaultUser.id),
      displayName: config.defaultUser.displayName,
      permissions: config.defaultUser.permissions,
      password: { salt, hash: hashPassword(config.defaultUser.password, salt) },
      createdAt: new Date().toISOString()
    };
    await writeJsonFile(userPath, user);
    console.log(`[euthersync] created default user '${user.id}'. Change the default password before real use.`);
  }
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, stored) {
  const actual = Buffer.from(hashPassword(password, stored.salt), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function verifyUserPassword(password, user) {
  if (user.passwordHash) return verifyHostPassword(password, user.passwordHash);
  if (user.password) return verifyPassword(password, user.password);
  return false;
}

async function verifyHostPassword(password, passwordHash) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.hostVerifyBin, ["--host-verify-password", passwordHash], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `password verifier exited with ${code}`));
      }
      resolve(stdout.trim() === "true");
    });
    child.stdin.end(password);
  });
}

function parseHostUsersToml(contents) {
  const users = [];
  let current = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[user]]") {
      current = {};
      users.push(current);
      continue;
    }
    if (!current) continue;

    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!match) continue;
    current[match[1]] = parseTomlValue(match[2]);
  }

  return users
    .filter((user) => typeof user.name === "string" && typeof user.password_hash === "string")
    .map((user) => ({
      id: user.name,
      displayName: user.name,
      passwordHash: user.password_hash,
      permissions: hostPermissions(user)
    }));
}

function parseTomlValue(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function hostPermissions(user) {
  const enabled = user.banned !== true;
  const admin = enabled && (user.admin === true || user.name === "nichlas");
  const mediaBackup =
    user.euthersync_media_backup === true ||
    (user.euthersync_media_backup !== false &&
      (user.admin === true || user.can_upload_roms === true || user.can_manage_library === true));
  return {
    feed_read: enabled,
    feed_post: enabled && user.euthersync_feed_post !== false,
    media_backup: enabled && mediaBackup,
    admin
  };
}

function publicUser(user) {
  return { id: user.id, displayName: user.displayName || user.id, permissions: normalizePermissions(user.permissions) };
}

function normalizePermissions(permissions = {}) {
  return {
    feed_read: permissions.feed_read !== false,
    feed_post: permissions.feed_post !== false,
    media_backup: permissions.media_backup === true,
    admin: permissions.admin === true
  };
}

function hasPermission(user, permission) {
  return normalizePermissions(user?.permissions)[permission] === true;
}

async function writeHostUserPermission(userId, permission, enabled) {
  const contents = await readFile(config.hostUsersPath, "utf8");
  const next = updateHostUserPermissionToml(contents, userId, permission, enabled);
  await writeFile(config.hostUsersPath, next.endsWith("\n") ? next : `${next}\n`);
}

function updateHostUserPermissionToml(contents, userId, permission, enabled) {
  const field = hostPermissionField(permission);
  const lines = contents.split(/\r?\n/);
  const users = hostUserBlocks(lines);
  const target = users.find((entry) => entry.name?.toLowerCase() === userId.toLowerCase());
  if (!target) throw new Error("User not found");
  if (permission === "admin" && target.name === "nichlas" && !enabled) {
    throw new Error("Super user admin permission cannot be removed");
  }
  if (permission === "admin" && target.admin === true && !enabled) {
    const activeAdmins = users.filter((entry) => !entry.banned && (entry.admin || entry.name === "nichlas")).length;
    if (activeAdmins <= 1) throw new Error("At least one active admin is required");
  }

  const line = `${field} = ${enabled ? "true" : "false"}`;
  let inserted = false;
  for (let index = target.start + 1; index < target.end; index += 1) {
    if (tomlKey(lines[index]) !== field) continue;
    lines[index] = line;
    inserted = true;
    break;
  }
  if (!inserted) {
    lines.splice(target.end, 0, line);
  }
  return lines.join("\n");
}

function hostPermissionField(permission) {
  if (permission === "media_backup") return "euthersync_media_backup";
  if (permission === "feed_post") return "euthersync_feed_post";
  if (permission === "admin") return "admin";
  throw new Error("Invalid permission");
}

function hostUserBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "[[user]]") continue;
    const start = index;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === "[[user]]") {
        end = cursor;
        break;
      }
    }
    const block = { start, end, name: "", admin: false, banned: false };
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      const key = tomlKey(lines[cursor]);
      if (key === "name") block.name = parseTomlValue(lines[cursor].split("=").slice(1).join("="));
      if (key === "admin") block.admin = parseTomlValue(lines[cursor].split("=").slice(1).join("=")) === true;
      if (key === "banned") block.banned = parseTomlValue(lines[cursor].split("=").slice(1).join("=")) === true;
    }
    blocks.push(block);
  }
  return blocks;
}

function tomlKey(line) {
  const match = line.trim().match(/^([A-Za-z0-9_]+)\s*=/);
  return match?.[1] || "";
}

async function readUserPreferences(user) {
  const preferences = { theme: "dark", skin: "classic" };
  const settingsPath = hostUserSettingsPath(user);
  if (!settingsPath) return preferences;
  try {
    const contents = await readFile(settingsPath, "utf8");
    preferences.theme = normalizeTheme(parseTomlString(contents, "theme") || preferences.theme);
    preferences.skin = normalizeSkin(parseTomlString(contents, "skin") || preferences.skin);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[euthersync] settings read failed", error);
  }
  return preferences;
}

async function writeUserPreferences(user, preferences) {
  const settingsPath = hostUserSettingsPath(user);
  if (!settingsPath) return;
  let existing = "";
  try {
    existing = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = upsertTomlString(upsertTomlString(existing, "theme", preferences.theme), "skin", preferences.skin);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, next.endsWith("\n") ? next : `${next}\n`);
}

function normalizeUserPreferences(value) {
  return {
    theme: normalizeTheme(value?.theme),
    skin: normalizeSkin(value?.skin)
  };
}

function normalizeTheme(value) {
  return value === "light" || value === "royal-apothic" ? value : "dark";
}

function normalizeSkin(value) {
  return value === "glass" || value === "arcade" ? value : "classic";
}

function hostUserSettingsPath(user) {
  if (!config.hostUsersPath) return null;
  return path.join(path.dirname(config.hostUsersPath), "user-data", hostUserStorageName(user.id), "settings.toml");
}

function hostUserStorageName(userId) {
  let output = "";
  for (const byte of Buffer.from(String(userId))) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9_-]/.test(char)) output += char;
    else output += `%${byte.toString(16).padStart(2, "0")}`;
  }
  return output || "user";
}

function parseTomlString(contents, key) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const [name, ...rest] = rawLine.split("=");
    if (name?.trim() !== key) continue;
    return rest.join("=").trim().replace(/^"|"$/g, "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return null;
}

function upsertTomlString(contents, key, value) {
  const line = `${key} = "${tomlEscape(value)}"`;
  const lines = contents.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((rawLine) => {
    const [name] = rawLine.split("=");
    if (name?.trim() !== key) return rawLine;
    replaced = true;
    return line;
  });
  if (!replaced) next.push(line);
  return next.filter((entry, index) => entry.length > 0 || index < next.length - 1).join("\n");
}

function tomlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function createFeedImageVariants(originalPath, postId) {
  const feedName = `${postId}-feed.webp`;
  const thumbName = `${postId}-thumb.webp`;
  const feedPath = path.join(paths.feedMedia(), feedName);
  const thumbPath = path.join(paths.feedMedia(), thumbName);

  try {
    await runImageMagick([
      originalPath,
      "-auto-orient",
      "-strip",
      "-resize",
      "1280x1280>",
      "-quality",
      "82",
      feedPath
    ]);
    await runImageMagick([
      originalPath,
      "-auto-orient",
      "-strip",
      "-resize",
      "420x420^",
      "-gravity",
      "center",
      "-extent",
      "420x420",
      "-quality",
      "78",
      thumbPath
    ]);
    return {
      feedUrl: `/media/feed/${feedName}`,
      thumbnailUrl: `/media/feed/${thumbName}`
    };
  } catch (error) {
    console.error("[euthersync] image variant generation failed", error);
    return {
      feedUrl: `/media/feed/${path.basename(originalPath)}`,
      thumbnailUrl: null
    };
  }
}

async function runImageMagick(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(config.imageMagickBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ImageMagick exited with ${code}`));
    });
  });
}

async function deleteFeedMedia(media) {
  if (!media) return;
  const urls = new Set([media.url, media.originalUrl, media.thumbnail].filter(Boolean));
  await Promise.all([...urls].map((mediaUrl) => deleteFeedMediaUrl(mediaUrl)));
}

async function deleteFeedMediaUrl(mediaUrl) {
  const prefix = "/media/feed/";
  if (!String(mediaUrl).startsWith(prefix)) return;
  const filePath = path.join(paths.feedMedia(), cleanFileName(String(mediaUrl).slice(prefix.length)));
  if (!filePath.startsWith(paths.feedMedia())) return;
  await rm(filePath, { force: true });
}

async function readFeeds() {
  const data = await readJsonFile(paths.feeds(), null);
  const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
  const normalized = feeds
    .map((feed) => ({
      id: normalizeFeedId(feed.id),
      name: cleanFeedName(feed.name) || "Untitled feed",
      createdBy: String(feed.createdBy || "system"),
      createdAt: String(feed.createdAt || new Date().toISOString()),
      updatedAt: feed.updatedAt ? String(feed.updatedAt) : undefined,
      system: feed.system === true
    }))
    .filter((feed) => feed.id);
  if (!normalized.some((feed) => feed.id === "family")) {
    normalized.unshift(defaultFamilyFeed());
  }
  return normalized;
}

async function writeFeeds(feeds) {
  await writeJsonFile(paths.feeds(), { feeds });
}

async function findFeed(feedId) {
  const id = normalizeFeedId(feedId || "family");
  return (await readFeeds()).find((feed) => feed.id === id) || null;
}

function defaultFamilyFeed() {
  return {
    id: "family",
    name: "Family feed",
    createdBy: "system",
    createdAt: "2026-06-07T00:00:00.000Z",
    system: true
  };
}

function uniqueFeedId(name, feeds) {
  const base = normalizeFeedId(name) || "feed";
  const taken = new Set(feeds.map((feed) => feed.id));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeFeedId(value) {
  return safeId(String(value || "").trim()) || "family";
}

function cleanFeedName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}

function feedIdFromFeedRoute(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return normalizeFeedId(parts[2] || "family");
}

async function readManifest(userId, deviceId, deviceName) {
  const manifest = await readJsonFile(path.join(paths.device(userId, deviceId), "manifest.json"), null);
  return manifest || {
    device: { id: deviceId, name: deviceName, owner: userId },
    files: []
  };
}

async function writeManifest(userId, deviceId, manifest) {
  await writeJsonFile(path.join(paths.device(userId, deviceId), "manifest.json"), manifest);
}

async function findUserFile(userId, fileId) {
  let deviceDirs = [];
  try {
    deviceDirs = await import("node:fs/promises").then((fs) => fs.readdir(paths.libraryUser(userId), { withFileTypes: true }));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const dir of deviceDirs.filter((entry) => entry.isDirectory())) {
    const deviceId = dir.name;
    const manifest = await readJsonFile(path.join(paths.device(userId, deviceId), "manifest.json"), null);
    const file = manifest?.files.find((entry) => entry.id === fileId);
    if (file) return { deviceId, manifest, file };
  }
  return null;
}

function parseCommentRoute(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const ok = parts[0] === "api" &&
    parts[1] === "feed" &&
    parts[2] === "posts" &&
    parts[4] === "comments" &&
    (parts.length === 5 || parts.length === 6);
  return {
    ok,
    postId: safeId(parts[3] || ""),
    commentId: safeId(parts[5] || "")
  };
}

async function feedPostExists(postId) {
  if (!postId) return false;
  const post = await readJsonFile(path.join(paths.feedPosts(), `${postId}.json`), null);
  return Boolean(post);
}

function feedCommentsPath(postId) {
  return path.join(paths.feedComments(), `${safeId(postId)}.json`);
}

async function readFeedComments(postId) {
  const data = await readJsonFile(feedCommentsPath(postId), { comments: [] });
  return Array.isArray(data?.comments)
    ? data.comments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    : [];
}

async function writeFeedComments(postId, comments) {
  await writeJsonFile(feedCommentsPath(postId), { comments });
}

async function feedCommentCount(postId) {
  return (await readFeedComments(postId)).length;
}

async function ensureStorage(storagePath) {
  await Promise.all([
    mkdir(path.join(storagePath, "config"), { recursive: true }),
    mkdir(path.join(storagePath, "users"), { recursive: true }),
    mkdir(path.join(storagePath, "devices"), { recursive: true }),
    mkdir(path.join(storagePath, "library"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "posts"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "media"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "comments"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "thumbnails"), { recursive: true })
  ]);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function cookie(name, value, maxAge) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function parseCookies(header) {
  return Object.fromEntries(
    header.split(";").filter(Boolean).map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
    })
  );
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function cleanFileName(value) {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 160);
}

function extensionForMime(mimeType) {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif"
  }[mimeType] || "";
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm"
  }[ext] || "application/octet-stream";
}

function logRequest(req, url) {
  if (url.pathname === "/health") return;
  console.log(`[euthersync] ${req.method} ${url.pathname}`);
}
