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

// ✅ Wichtig bei Render/Railway/Fly/NGINX: damit req.protocol korrekt ist (https)
app.set("trust proxy", 1);

// ✅ CORS: online erstmal offen lassen (später kannst du einschränken)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
});

// ✅ PORT muss vom Hoster kommen können
const PORT = Number(process.env.PORT) || 3001;

// ⚠️ Dein fixes Passwort (ok für private Runden, später besser per ENV)
const DEFAULT_DM_PASSWORD = process.env.DM_PASSWORD || "LeckMich994!";

/* =========================
   Upload Setup
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Static hosting der Uploads
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ✅ Upload-URL darf NICHT localhost sein -> dynamisch aus Host bauen
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

  const baseUrl = `${req.protocol}://${req.get("host")}`;

  res.json({
    ok: true,
    url: `${baseUrl}/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
  });
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
      dmPasswordHash: bcrypt.hashSync(DEFAULT_DM_PASSWORD, 8),
    });

    cb?.({ ok: true, roomId });
  });

  /* ===== ROOM JOIN ===== */
  socket.on("room:join", ({ roomId, name, imgUrl, color }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    socket.join(roomId);

    room.state.tokens[socket.id] = {
      id: socket.id,
      kind: "player",
      ownerId: socket.id,
      name: (name || "Player").slice(0, 24),
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 200,
      imgUrl: (imgUrl || "").slice(0, 400),
      color: (color || "").slice(0, 32),
    };

    cb?.({ ok: true, state: room.state });

    socket.to(roomId).emit("state:patch", {
      type: "token:upsert",
      token: room.state.tokens[socket.id],
    });

    socket.emit("state:patch", {
      type: "room:dm",
      dmId: room.dmId,
    });
  });

  /* ===== TOKEN MOVE ===== */
  socket.on("token:move", ({ roomId, x, y }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const t = room.state.tokens[socket.id];
    if (!t) return cb?.({ ok: false, error: "TOKEN_NOT_FOUND" });

    const nx = clamp(x, 0, room.state.map.width);
    const ny = clamp(y, 0, room.state.map.height);

    t.x = nx;
    t.y = ny;

    socket.to(roomId).emit("state:patch", {
      type: "token:move",
      id: socket.id,
      x: nx,
      y: ny,
    });

    cb?.({ ok: true });
  });

  /* ===== ADD ENEMY (DM ONLY) ===== */
  socket.on("token:addEnemy", ({ roomId, name, imgUrl, x, y }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const id = `enemy_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const nx = clamp(x, 0, room.state.map.width);
    const ny = clamp(y, 0, room.state.map.height);

    const token = {
      id,
      kind: "enemy",
      name: (name || "Enemy").slice(0, 24),
      x: nx,
      y: ny,
      imgUrl: (imgUrl || "").slice(0, 400),
    };

    room.state.tokens[id] = token;

    io.to(roomId).emit("state:patch", { type: "token:upsert", token });
    cb?.({ ok: true, token });
  });

  /* ===== DM LOGIN ===== */
  socket.on("dm:login", async ({ roomId, password }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const pw = String(password || "");
    const ok = await bcrypt.compare(pw, room.dmPasswordHash);
    if (!ok) return cb?.({ ok: false, error: "WRONG_PASSWORD" });

    room.dmId = socket.id;
    room.state.dmId = socket.id;

    broadcastPatch(roomId, { type: "room:dm", dmId: socket.id });
    cb?.({ ok: true });
  });

  /* ===== MAP SET (DM ONLY) ===== */
  socket.on("map:set", ({ roomId, url, width, height }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    room.state.map = {
      url: String(url || "").slice(0, 800),
      width: Number(width) || 2000,
      height: Number(height) || 1400,
    };

    broadcastPatch(roomId, { type: "map:set", map: room.state.map });
    cb?.({ ok: true });
  });

  /* ===== EFFECT ADD (DM ONLY) ===== */
  socket.on("effect:add", ({ roomId, effect }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    const id = "effect_" + Date.now();
    const e = { ...effect, id };

    room.state.effects[id] = e;
    broadcastPatch(roomId, { type: "effect:upsert", effect: e });

    cb?.({ ok: true, effect: e });
  });

  /* ===== EFFECT REMOVE (DM ONLY) ===== */
  socket.on("effect:remove", ({ roomId, id }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (room.dmId !== socket.id) return cb?.({ ok: false, error: "NOT_DM" });

    if (room.state.effects[id]) {
      delete room.state.effects[id];
      broadcastPatch(roomId, { type: "effect:remove", id });
    }

    cb?.({ ok: true });
  });

  /* ===== DISCONNECT ===== */
  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.state?.tokens?.[socket.id]) {
        delete room.state.tokens[socket.id];
        broadcastPatch(roomId, { type: "token:remove", id: socket.id });
      }

      if (room.dmId === socket.id) {
        room.dmId = null;
        room.state.dmId = null;
        broadcastPatch(roomId, { type: "room:dm", dmId: null });
      }
    }
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

// Optional: Root route (damit Browser nicht "Cannot GET /" zeigt)
app.get("/", (_, res) => res.send("OK"));

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});