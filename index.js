import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";

const app = express();

app.set("trust proxy", 1);

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

const PORT = Number(process.env.PORT) || 3001;

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
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

    // attacks[attackerId] = { attackerId, targetId, at }
    attacks: {},
  };
}

function clamp(n, min, max) {
  const v = Number(n);
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(v, max));
}

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  const iv = Math.trunc(v);
  return Math.max(min, Math.min(iv, max));
}

function broadcastPatch(roomId, patch) {
  io.to(roomId).emit("state:patch", patch);
}

function createDmPasswordHash() {
  if (!DM_PASSWORD) return null;
  return bcrypt.hashSync(String(DM_PASSWORD), 10);
}

/* =========================
   Event Log (in-memory)
   (legacy / optional)
========================= */
function makeEvent(type, payload = {}) {
  return {
    id: `ev_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    at: Date.now(),
    type,
    visibility: payload.visibility === "DM" ? "DM" : "ALL",
    ...payload,
  };
}

function pushRoomEvent(room, ev) {
  if (!room.events) room.events = [];
  room.events.push(ev);

  const MAX = 300;
  if (room.events.length > MAX) room.events = room.events.slice(-MAX);
}

/* =========================
   Attacks helpers
========================= */
function ensureAttacks(room) {
  if (!room.state.attacks || typeof room.state.attacks !== "object") room.state.attacks = {};
}

function clearAttacksInvolvingToken(room, tokenId) {
  ensureAttacks(room);
  const attacks = room.state.attacks;

  const removedAttackerIds = [];
  for (const [attackerId, a] of Object.entries(attacks)) {
    if (!a) continue;
    if (attackerId === tokenId || a.attackerId === tokenId || a.targetId === tokenId) {
      delete attacks[attackerId];
      removedAttackerIds.push(attackerId);
    }
  }

  for (const attackerId of removedAttackerIds) {
    broadcastPatch(room.id, { type: "attack:clear", attackerId });
  }
}

/* =========================
   Socket
========================= */
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("room:create", (_, cb) => {
    let roomId = makeRoomId();
    while (rooms.has(roomId)) roomId = makeRoomId();

    rooms.set(roomId, {
      id: roomId,
      state: makeInitialState(),
      dmId: null,
      dmPasswordHash: createDmPasswordHash(),
      events: [],
    });

    cb?.({ ok: true, roomId });
  });

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

    // state enthält map/tokens/effects/dmId/attacks
    cb?.({ ok: true, state: room.state });

    socket.to(rid).emit("state:patch", { type: "token:upsert", token });
    socket.emit("state:patch", { type: "room:dm", dmId: room.dmId });
  });

  /* ===== EVENT HISTORY (optional legacy) ===== */
  socket.on("event:history", ({ roomId, limit }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const n = clampInt(limit ?? 120, 1, 300);
    const events = Array.isArray(room.events) ? room.events.slice(-n) : [];

    cb?.({ ok: true, events });
  });

  /* ===== TOKEN MOVE ===== */
  socket.on("token:move", ({ roomId, id, x, y }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const targetId = String(id || socket.id);
    const t = room.state.tokens[targetId];
    if (!t) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });

    if (targetId !== socket.id && room.dmId !== socket.id) {
      return cb?.({ ok: false, error: "NOT_ALLOWED" });
    }

    const nx = clamp(x, 0, room.state.map.width);
    const ny = clamp(y, 0, room.state.map.height);

    t.x = nx;
    t.y = ny;

    io.to(room.id).emit("state:patch", {
      type: "token:move",
      id: targetId,
      x: nx,
      y: ny,
    });

    cb?.({ ok: true });
  });

  /* ===== ENEMY ADD ===== */
  socket.on("token:addEnemy", ({ roomId, name, imgUrl, x, y, hp }, cb) => {
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
      hp: clampInt(hp ?? 0, 0, 9999),
    };

    room.state.tokens[id] = token;

    io.to(room.id).emit("state:patch", { type: "token:upsert", token });
    cb?.({ ok: true, token });
  });

  /* ===== ENEMY REMOVE ===== */
  socket.on("token:removeEnemy", ({ roomId, id }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const tid = String(id || "");
    const t = room.state.tokens[tid];
    if (!t) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });
    if (t.kind !== "enemy") return cb?.({ ok: false, error: "NOT_ENEMY" });

    delete room.state.tokens[tid];
    broadcastPatch(room.id, { type: "token:remove", id: tid });

    clearAttacksInvolvingToken(room, tid);

    cb?.({ ok: true });
  });

  /* ===== ENEMY HP UPDATE ===== */
  socket.on("token:setHp", ({ roomId, id, hp }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const tid = String(id || "");
    const t = room.state.tokens[tid];
    if (!t) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });
    if (t.kind !== "enemy") return cb?.({ ok: false, error: "NOT_ENEMY" });

    t.hp = clampInt(hp ?? 0, 0, 9999);

    io.to(room.id).emit("state:patch", { type: "token:upsert", token: t });
    cb?.({ ok: true, hp: t.hp });
  });

  /* ===== PERSISTENT ATTACK LINES ===== */
  socket.on("attack:set", ({ roomId, attackerId, targetId }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    ensureAttacks(room);

    const aId = String(attackerId || socket.id);
    const tId = String(targetId || "");

    const attacker = room.state.tokens[aId];
    const target = room.state.tokens[tId];

    if (!attacker) return cb?.({ ok: false, error: "ATTACKER_NOT_FOUND" });
    if (!target) return cb?.({ ok: false, error: "TARGET_NOT_FOUND" });
    if (aId === tId) return cb?.({ ok: false, error: "SAME_TOKEN" });

    if (aId !== socket.id && room.dmId !== socket.id) {
      return cb?.({ ok: false, error: "NOT_ALLOWED" });
    }

    const entry = { attackerId: aId, targetId: tId, at: Date.now() };
    room.state.attacks[aId] = entry;

    broadcastPatch(room.id, { type: "attack:set", attack: entry });

    cb?.({ ok: true, attack: entry });
  });

  socket.on("attack:clear", ({ roomId, attackerId }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    ensureAttacks(room);

    const aId = String(attackerId || socket.id);

    if (aId !== socket.id && room.dmId !== socket.id) {
      return cb?.({ ok: false, error: "NOT_ALLOWED" });
    }

    if (room.state.attacks[aId]) {
      delete room.state.attacks[aId];
      broadcastPatch(room.id, { type: "attack:clear", attackerId: aId });
    }

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

    // ✅ IMPORTANT: keep both fields in sync
    room.dmId = socket.id;
    room.state.dmId = socket.id;

    broadcastPatch(room.id, { type: "room:dm", dmId: socket.id });
    cb?.({ ok: true });
  });

  /* ===== MAP SET ===== */
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

  /* ===== EFFECTS ===== */
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

  /* ===== EVENTS (legacy) ===== */
  socket.on("event:log", ({ roomId, type, title, text, visibility }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    if (visibility === "DM" && room.dmId !== socket.id) {
      return cb?.({ ok: false, error: "NOT_DM" });
    }

    const ev = makeEvent(String(type || "note"), {
      title: String(title || "").slice(0, 60),
      text: String(text || "").slice(0, 240),
      visibility: visibility === "DM" ? "DM" : "ALL",
    });

    pushRoomEvent(room, ev);

    io.to(room.id).emit("event:new", ev);
    cb?.({ ok: true });
  });

  socket.on("event:attack", ({ roomId, attackerId, targetId, text, visibility }, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    if (visibility === "DM" && room.dmId !== socket.id) {
      return cb?.({ ok: false, error: "NOT_DM" });
    }

    const a = room.state.tokens[String(attackerId || "")];
    const b = room.state.tokens[String(targetId || "")];

    const ev = makeEvent("attack", {
      attackerId,
      targetId,
      attackerName: a?.name,
      targetName: b?.name,
      text: String(text || "").slice(0, 240),
      visibility: visibility === "DM" ? "DM" : "ALL",
    });

    pushRoomEvent(room, ev);

    io.to(room.id).emit("event:new", ev);
    cb?.({ ok: true });
  });

  /* ===== DISCONNECT ===== */
  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const rid = room.id;

      if (room.state?.tokens?.[socket.id]) {
        delete room.state.tokens[socket.id];
        broadcastPatch(rid, { type: "token:remove", id: socket.id });

        clearAttacksInvolvingToken(room, socket.id);
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