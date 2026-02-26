const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, PrivateKey } = require('@hiveio/dhive');

const app = express();
app.use(cors());

// --- HIVE CONFIGURATION ---
const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
const ACCOUNT_NAME = 'cbrs'; 
const ACTIVE_KEY = process.env.HIVE_ACTIVE_KEY ? PrivateKey.fromString(process.env.HIVE_ACTIVE_KEY) : null;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- STATE MANAGEMENT ---
let connectedUsers = {}; // Tracks socket.id -> username
let games = {};           

/**
 * Broadcasts the current lobby status to all connected clients
 * Includes: Online users, Open rooms (waiting), and Active battles
 */
function broadcastLobbyState() {
    const usersInLobby = Object.values(connectedUsers);
    
    // Find rooms where player2 is null (Waiting for opponent)
    const openRooms = Object.keys(games)
        .filter(code => games[code].player2 === null)
        .map(code => ({ code, host: games[code].player1.username }));

    // Find rooms where battle is ongoing
    const activeBattles = Object.keys(games)
        .filter(code => games[code].player2 !== null)
        .map(code => ({ 
            p1: games[code].player1.username, 
            p2: games[code].player2.username 
        }));

    io.emit('lobby_state_update', {
        users: usersInLobby,
        openRooms: openRooms,
        activeBattles: activeBattles
    });
}

/**
 * Handles the automated 3-way payout on the blockchain
 */
async function processMatchPayout(winner, loser) {
    if (!ACTIVE_KEY) {
        console.log("❌ ERROR: Active Key not set. Payout skipped.");
        return;
    }

    const payouts = [
        { to: winner, amount: "1.900 HIVE", memo: `🏆 Victory payout vs @${loser} (Hive Battleship)` },
        { to: 'null', amount: "0.050 HIVE", memo: "🔥 Deflationary Burn (Hive Battleship)" },
        { to: 'cbrs', amount: "0.050 HIVE", memo: "🏦 Dev Fee (Hive Battleship)" }
    ];

    for (const p of payouts) {
        try {
            await client.broadcast.transfer({
                from: ACCOUNT_NAME,
                to: p.to,
                amount: p.amount,
                memo: p.memo
            }, ACTIVE_KEY);
            console.log(`✅ Paid ${p.amount} to ${p.to}`);
        } catch (err) {
            console.error(`❌ Payout failed for ${p.to}:`, err.message);
        }
    }
}

io.on('connection', (socket) => {
    console.log(`📡 Player connected: ${socket.id}`);

    // --- NEW: USER REGISTRATION ---
    // Links Hive username to socket ID and updates the radar
    socket.on('register_user', (data) => {
        connectedUsers[socket.id] = data.username;
        broadcastLobbyState();
    });

    // --- CUSTOM LOBBY LOGIC ---
    socket.on('create_lobby', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 7);
        const playerObj = { socket, username: data.username, board: data.board };
        games[roomCode] = {
            player1: playerObj,
            player2: null,
            currentTurn: socket.id,
            hits: { [socket.id]: 0 }
        };
        socket.join(roomCode);
        socket.emit('lobby_created', { roomCode });
        
        broadcastLobbyState(); // Update radar with the new open room
        console.log(`🏠 Lobby created: ${roomCode} by ${data.username}`);
    });

    socket.on('join_lobby', (data) => {
        const { username, board, roomCode } = data;
        const game = games[roomCode];
        if (!game || game.player2 !== null) {
            socket.emit('lobby_error', { message: "Room not found or full!" });
            return;
        }
        const playerObj = { socket, username, board };
        game.player2 = playerObj;
        game.hits[socket.id] = 0;
        socket.join(roomCode);
        game.player1.socket.emit('match_found', { opponentName: playerObj.username, yourTurn: true, roomId: roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: roomCode });
        
        broadcastLobbyState(); // Update radar to show the battle is now active
        console.log(`⚔️ Match started in lobby ${roomCode}!`);
    });

    socket.on('fire_missile', (data) => {
        const { roomId, targetIndex } = data;
        const game = games[roomId];
        if (!game || game.currentTurn !== socket.id) return;

        const isPlayer1 = (socket.id === game.player1.socket.id);
        const attacker = isPlayer1 ? game.player1 : game.player2;
        const defender = isPlayer1 ? game.player2 : game.player1;

        const isHit = (defender.board[targetIndex] !== null);
        io.to(roomId).emit('missile_result', { targetIndex, isHit, attackerId: socket.id });

        if (isHit) {
            game.hits[socket.id] += 1;
            if (game.hits[socket.id] >= 17) {
                console.log(`🏁 GAME OVER! ${attacker.username} won!`);
                io.to(roomId).emit('game_over', {
                    winnerId: socket.id,
                    winnerName: attacker.username,
                    loserName: defender.username
                });

                processMatchPayout(attacker.username, defender.username);
                
                delete games[roomId];
                broadcastLobbyState(); // Remove from active battles list
                return;
            }
        }
        game.currentTurn = defender.socket.id;
        io.to(roomId).emit('turn_update', { currentTurnId: game.currentTurn });
    });

    // --- UPDATED DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        console.log(`📡 Player disconnected: ${socket.id}`);
        
        // Remove from online list
        delete connectedUsers[socket.id];

        // Clean up any hosted games that were waiting for an opponent
        for (const code in games) {
            if (games[code].player1.socket.id === socket.id && games[code].player2 === null) {
                console.log(`🗑️ Closing empty lobby ${code} (host disconnected)`);
                delete games[code];
            }
        }

        broadcastLobbyState(); // Update everyone's radar
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Battleship Server running on port ${PORT}`);
});
