import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import "dotenv/config";

const app = express();

/**
 * Behind Render/Proxy: needed for correct req.protocol (https) and secure cookies.
 */
app.set("trust proxy", 1);

/**
 * CORS:
 * - In production: set CLIENT_ORIGIN to your Netlify URL (e.g. https://xyz.netlify.app)
 * - In dev: allow localhost
 */
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/**
 * PORT must come from the host.
 */
const PORT = Number(process.env.PORT) || 3001;

/**
 * DM password:
 * Require ENV in production to avoid accidental weak default online.
 */
const DM_PASSWORD = process.env.DM_PASSWORD;
if (!DM_PASSWORD) {
  console.warn(
    "WARNING: DM_PASSWORD is not set. DM login will not work until you set it in the environment."
  );
}

/* =========================
   Upload Setup
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded files
app.use("/uploads", express.static(uploadsDir, { maxAge: "1h" }));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safe = String(file.originalname || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/**
 * Upload endpoint
 * - Returns absolute URL based on request host
 * - Works behind Render proxy thanks to trust proxy
 */
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    return res.json({
      ok: true,
      url: `${baseUrl}/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
    });
  } catch (e) {
    console.error("Upload error:", e);
    return res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
  }
});

/* =========================
   Rooms
========================= */
const rooms = new Map();

function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function makeInitialState() {
  return {
    map: {
      url: "https://upload.wikimedia.org/wikipedia/commons/5/5a/Parchment.00.jpg",
      width: 2000,
      height: 1400,
    },
    tokens: {},
    effects: {},
    dmId: null,
  };
}

function clamp(n, min, max) {
  const v = Number(n);
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(v, max));
}

function broadcastPatch(roomId, patch) {
  io.to(roomId).emit("state:patch", patch);
}

/**
 * Create per-room password hash.
 * If DM_PASSWORD missing -> set hash to null and block dm:login.
 */
function createDmPasswordHash() {
  if (!DM_PASSWORD) return null;
  return bcrypt.hashSync(String(DM_PASSWORD), 10);
}

function makeEvent(payload) {
  // Keep it loose & forward-compatible
  const id = `ev_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  return {
    id,
    at: Date.now(),
    ...payload,
  };
}

/* =========================
   Socket
========================= */
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* ===== ROOM CREATE ===== */
  socket.on("room:create", (_, cb) => {
    let roomId = makeRoomId();
    while (rooms.has(roomId)) roomId = makeRoomId();

    rooms.set(roomId, {
      id: roomId,
      state: makeInitialState(),
      dmId: null,
      dmPasswordHash: createDmPasswordHash(),
    });

    cb?.({ ok: true, roomId });
  });

  /* ===== ROOM JOIN ===== */
  socket.on("room:join", ({ roomId, name, imgUrl, color }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const rid = room.id;
    socket.join(rid);

    const token = {
      id: socket.id,
      kind: "player",
      ownerId: socket.id,
      name: String(name || "Player").slice(0, 24),
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 200,
      imgUrl: String(imgUrl || "").slice(0, 400),
      color: String(color || "").slice(0, 32),
    };

    room.state.tokens[socket.id] = token;

    cb?.({ ok: true, state: room.state });

    socket.to(rid).emit("state:patch", {
      type: "token:upsert",
      token,
    });

    socket.emit("state:patch", {
      type: "room:dm",
      dmId: room.dmId,
    });
  });

  /* ===== TOKEN MOVE =====
     - Player: can move only own token (no id needed)
     - DM: can move enemy tokens by providing id
  */
  socket.on("token:move", ({ roomId, id, x, y }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const rid = room.id;

    // Default: self move
    const targetId = String(id || socket.id);

    // If moving someone else -> must be DM and must be enemy
    if (targetId !== socket.id) {
      if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

      const tOther = room.state.tokens[targetId];
      if (!tOther) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });
      if (tOther.kind !== "enemy") return cb?.({ ok: false, error: "ONLY_ENEMY_MOVABLE" });

      const nx = clamp(x, 0, room.state.map.width);
      const ny = clamp(y, 0, room.state.map.height);

      tOther.x = nx;
      tOther.y = ny;

      io.to(rid).emit("state:patch", {
        type: "token:move",
        id: targetId,
        x: nx,
        y: ny,
      });

      return cb?.({ ok: true });
    }

    // Self move
    const t = room.state.tokens[socket.id];
    if (!t) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });

    const nx = clamp(x, 0, room.state.map.width);
    const ny = clamp(y, 0, room.state.map.height);

    t.x = nx;
    t.y = ny;

    socket.to(rid).emit("state:patch", {
      type: "token:move",
      id: socket.id,
      x: nx,
      y: ny,
    });

    cb?.({ ok: true });
  });

  /* ===== ADD ENEMY (DM ONLY) ===== */
  socket.on("token:addEnemy", ({ roomId, name, imgUrl, x, y }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const id = `enemy_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const nx = clamp(x, 0, room.state.map.width);
    const ny = clamp(y, 0, room.state.map.height);

    const token = {
      id,
      kind: "enemy",
      name: String(name || "Enemy").slice(0, 24),
      x: nx,
      y: ny,
      imgUrl: String(imgUrl || "").slice(0, 400),
    };

    room.state.tokens[id] = token;

    io.to(room.id).emit("state:patch", { type: "token:upsert", token });
    cb?.({ ok: true, token });
  });

  /* ===== OPTIONAL: TOKEN REMOVE (DM ONLY) ===== */
  socket.on("token:remove", ({ roomId, id }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const key = String(id || "");
    if (!key) return cb?.({ ok: false, error: "BAD_ID" });
    if (!room.state.tokens[key]) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });

    delete room.state.tokens[key];
    io.to(room.id).emit("state:patch", { type: "token:remove", id: key });
    cb?.({ ok: true });
  });

  /* ===== DM LOGIN ===== */
  socket.on("dm:login", async ({ roomId, password }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    if (!room.dmPasswordHash) {
      return cb?.({ ok: false, error: "DM_PASSWORD_NOT_CONFIGURED" });
    }

    const pw = String(password || "");
    const ok = await bcrypt.compare(pw, room.dmPasswordHash);
    if (!ok) return cb?.({ ok: false, error: "WRONG_PASSWORD" });

    room.dmId = socket.id;
    room.state.dmId = socket.id;

    broadcastPatch(room.id, { type: "room:dm", dmId: socket.id });
    cb?.({ ok: true });
  });

  /* ===== MAP SET (DM ONLY) ===== */
  socket.on("map:set", ({ roomId, url, width, height }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const w = clamp(width, 200, 20000);
    const h = clamp(height, 200, 20000);

    room.state.map = {
      url: String(url || "").slice(0, 800),
      width: w,
      height: h,
    };

    broadcastPatch(room.id, { type: "map:set", map: room.state.map });
    cb?.({ ok: true });
  });

  /* ===== EFFECT ADD (DM ONLY) ===== */
  socket.on("effect:add", ({ roomId, effect }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const id = `effect_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const e = { ...(effect || {}), id };

    room.state.effects[id] = e;
    broadcastPatch(room.id, { type: "effect:upsert", effect: e });

    cb?.({ ok: true, effect: e });
  });

  /* ===== EFFECT REMOVE (DM ONLY) ===== */
  socket.on("effect:remove", ({ roomId, id }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const key = String(id || "");
    if (room.state.effects[key]) {
      delete room.state.effects[key];
      broadcastPatch(room.id, { type: "effect:remove", id: key });
    }

    cb?.({ ok: true });
  });

  /* ===== EVENT LOG (DM OR PLAYER) =====
     - Server just broadcasts; client filters DM-only if needed.
  */
  socket.on("event:log", ({ roomId, ...payload }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const ev = makeEvent({
      ...payload,
      by: socket.id,
    });

    io.to(room.id).emit("event:new", ev);
    cb?.({ ok: true, event: ev });
  });

  /* ===== EVENT ATTACK (DM OR PLAYER) ===== */
  socket.on("event:attack", ({ roomId, attackerId, targetId, text, visibility }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const a = room.state.tokens?.[String(attackerId || "")];
    const b = room.state.tokens?.[String(targetId || "")];

    const ev = makeEvent({
      type: "attack",
      attackerId: String(attackerId || ""),
      targetId: String(targetId || ""),
      attackerName: a?.name,
      targetName: b?.name,
      text: String(text || "").slice(0, 240),
      visibility: visibility === "DM" ? "DM" : "ALL",
      by: socket.id,
    });

    io.to(room.id).emit("event:new", ev);
    cb?.({ ok: true, event: ev });
  });

  /* ===== DISCONNECT ===== */
  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const rid = room.id;

      if (room.state?.tokens?.[socket.id]) {
        delete room.state.tokens[socket.id];
        broadcastPatch(rid, { type: "token:remove", id: socket.id });
      }

      if (room.dmId === socket.id) {
        room.dmId = null;
        room.state.dmId = null;
        broadcastPatch(rid, { type: "room:dm", dmId: null });
      }
    }
  });
});

/* =========================
   HTTP routes
========================= */
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.send("OK"));

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`CORS origin: ${CLIENT_ORIGIN}`);
});