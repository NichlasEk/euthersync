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
  feedMedia: () => path.join(config.storagePath, "feed", "media")
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
  if (req.method === "POST" && url.pathname === "/api/upload") return upload(req, res, url, user);
  if (req.method === "GET" && url.pathname === "/api/library") return library(res, user);
  if (req.method === "POST" && url.pathname === "/api/publish") return publish(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/feed/posts") return createFeedPost(req, res, user);
  if (req.method === "GET" && url.pathname === "/api/feed") return feed(res, user);
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
  const feedMediaName = `${postId}${extension}`;
  const feedMediaPath = path.join(paths.feedMedia(), feedMediaName);
  await mkdir(paths.feedMedia(), { recursive: true });
  await copyFile(sourcePath, feedMediaPath);

  const post = {
    post: {
      id: postId,
      author: user.id,
      authorName: user.displayName,
      caption,
      visibility: "family",
      createdAt: new Date().toISOString()
    },
    media: {
      fileId: found.file.id,
      originalName: found.file.originalName,
      mimeType: found.file.mimeType,
      url: `/media/feed/${feedMediaName}`,
      thumbnail: null
    }
  };
  await writeJsonFile(path.join(paths.feedPosts(), `${postId}.json`), post);
  return json(res, 201, { post });
}

async function feed(res, user) {
  if (!hasPermission(user, "feed_read")) return json(res, 403, { error: "feed_read permission required" });

  let posts = [];
  try {
    const names = await import("node:fs/promises").then((fs) => fs.readdir(paths.feedPosts()));
    posts = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile(path.join(paths.feedPosts(), name), null))
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  posts = posts.filter(Boolean).sort((a, b) => String(b.post.createdAt).localeCompare(String(a.post.createdAt)));
  return json(res, 200, { posts });
}

async function createFeedPost(req, res, user) {
  if (!hasPermission(user, "feed_post")) return json(res, 403, { error: "feed_post permission required" });
  const body = await readJson(req);
  const caption = String(body.caption || "").trim().slice(0, 500);
  if (!caption) return json(res, 400, { error: "Caption is required" });

  const post = {
    post: {
      id: randomUUID(),
      author: user.id,
      authorName: user.displayName,
      caption,
      visibility: "family",
      createdAt: new Date().toISOString()
    },
    media: null
  };
  await writeJsonFile(path.join(paths.feedPosts(), `${post.post.id}.json`), post);
  return json(res, 201, { post });
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
  if (config.hostUsersPath) {
    return json(res, 409, { error: "Users and permissions are managed by EutherOxide users.toml" });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const userId = safeId(parts[3] || "");
  const permission = parts[4];
  if (parts.length !== 5 || permission !== "media_backup") {
    return json(res, 400, { error: "Use /api/admin/users/:userId/media_backup" });
  }

  const target = await getUser(userId);
  if (!target) return json(res, 404, { error: "User not found" });

  const body = await readJson(req);
  target.permissions = normalizePermissions(target.permissions);
  target.permissions.media_backup = Boolean(body.enabled);
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
  return {
    feed_read: enabled,
    feed_post: enabled,
    media_backup: enabled && (user.admin === true || user.can_upload_roms === true || user.can_manage_library === true),
    admin: enabled && user.admin === true
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

async function ensureStorage(storagePath) {
  await Promise.all([
    mkdir(path.join(storagePath, "config"), { recursive: true }),
    mkdir(path.join(storagePath, "users"), { recursive: true }),
    mkdir(path.join(storagePath, "devices"), { recursive: true }),
    mkdir(path.join(storagePath, "library"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "posts"), { recursive: true }),
    mkdir(path.join(storagePath, "feed", "media"), { recursive: true }),
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
