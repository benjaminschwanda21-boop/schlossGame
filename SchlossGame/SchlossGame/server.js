const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Spiel.html"));
});

function generateRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

const rooms = {};
const TURN_TIME_MS = 15000; // 15 Sekunden pro Zug

// ---- Timer-Hilfsfunktionen ----
function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // alten Timer stoppen, falls vorhanden
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
  }

  room.turnTimer = setTimeout(() => {
    const r = rooms[roomId];
    if (!r || !r.started || r.winner) return;

    // Spieler, der dran war, hat seine 15 Sekunden verpasst
    const expiredPlayerId = r.turnOrder[0];
    const nextPlayerId = r.turnOrder[1];

    // Zug-Reihenfolge tauschen
    r.turnOrder = [nextPlayerId, expiredPlayerId];

    // Info an beide Clients: Zeit abgelaufen, anderer Spieler ist dran
    io.to(roomId).emit("turnTimeout", {
      roomId,
      expiredPlayerId,
      nextPlayerId
    });

    // neuen Timer für den nächsten Spieler starten
    startTurnTimer(roomId);
  }, TURN_TIME_MS);
}

function clearTurnTimer(roomId) {
  const room = rooms[roomId];
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

io.on("connection", (socket) => {
  console.log("Neue Verbindung:", socket.id);

  socket.on("createRoom", ({ name, codeLength }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: {},
      codeLength: codeLength || 3,
      started: false,
      turnOrder: [],
      winner: null,
      turnTimer: null // Timer pro Raum
    };

    rooms[roomId].players[socket.id] = { name, secret: "", ready: false };
    socket.join(roomId);

    socket.emit("roomCreated", {
      roomId,
      codeLength: rooms[roomId].codeLength
    });
    console.log(`Raum ${roomId} von ${name} erstellt`);
  });

  socket.on("joinRoom", ({ name, roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", { message: "Raum nicht gefunden." });
      return;
    }

    if (Object.keys(room.players).length >= 2) {
      socket.emit("errorMessage", { message: "Raum ist voll." });
      return;
    }

    room.players[socket.id] = { name, secret: "", ready: false };
    socket.join(roomId);

    const players = Object.entries(room.players).map(([id, p]) => ({
      socketId: id,
      name: p.name
    }));

    io.to(roomId).emit("roomJoined", {
      roomId,
      codeLength: room.codeLength,
      players
    });

    console.log(`${name} ist Raum ${roomId} beigetreten`);
  });

  socket.on("setSecret", ({ roomId, secret }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    if (secret.length !== room.codeLength || !/^\d+$/.test(secret)) return;

    room.players[socket.id].secret = secret;
    room.players[socket.id].ready = true;

    const allReady =
      Object.values(room.players).length === 2 &&
      Object.values(room.players).every((p) => p.ready);

    io.to(roomId).emit("playerReady", {
      playerId: socket.id,
      name: room.players[socket.id].name,
      allReady
    });

    if (allReady && !room.started) {
      room.started = true;
      const ids = Object.keys(room.players);
      room.turnOrder = Math.random() < 0.5 ? [ids[0], ids[1]] : [ids[1], ids[0]];
      const first = room.turnOrder[0];

      io.to(roomId).emit("gameStarted", {
        roomId,
        currentTurn: first
      });

      // Spiel startet → Timer für ersten Spieler
      startTurnTimer(roomId);
    }
  });

  socket.on("guess", ({ roomId, value }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;

    if (!/^\d+$/.test(value) || value.length !== room.codeLength) return;

    const currentIndex = room.turnOrder.indexOf(socket.id);
    if (currentIndex !== 0) {
      socket.emit("errorMessage", { message: "Du bist nicht am Zug." });
      return;
    }

    const opponentId = room.turnOrder[1];
    const opponent = room.players[opponentId];

    let correct = 0;
    for (let i = 0; i < room.codeLength; i++) {
      if (value[i] === opponent.secret[i]) correct++;
    }

    io.to(roomId).emit("guessResult", {
      from: socket.id,
      guess: value,
      correct
    });

    if (correct === room.codeLength) {
      room.winner = socket.id;

      io.to(roomId).emit("gameOver", {
        winner: socket.id,
        winnerName: room.players[socket.id].name,
        loserId: opponentId,
        loserName: opponent.name
      });

      // Spiel vorbei → Timer stoppen
      clearTurnTimer(roomId);
      return;
    }

    // Zug wechselt nach gültigem Tipp
    room.turnOrder = [opponentId, socket.id];

    // Info an alle, wer jetzt dran ist (kannst du im Frontend nutzen)
    io.to(roomId).emit("turnChanged", {
      roomId,
      currentTurn: opponentId
    });

    // Neuer Zug → Timer neu starten
    startTurnTimer(roomId);
  });
  socket.on("skipTurn", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    if (!room.turnOrder || room.turnOrder[0] !== socket.id) return;

    const [current, next] = room.turnOrder;
    room.turnOrder = [next, current];

    io.to(roomId).emit("turnSkipped", {
      from: current,
      next
    });
  });

  socket.on("disconnect", () => {
    console.log("Verbindung getrennt:", socket.id);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        io.to(roomId).emit("opponentLeft", { playerId: socket.id });

        if (Object.keys(room.players).length === 0) {
          // letzter Spieler weg → Timer löschen & Raum entfernen
          clearTurnTimer(roomId);
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});

