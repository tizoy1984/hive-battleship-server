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
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- STATE MANAGEMENT ---
let connectedUsers = {}; // Tracks socket.id -> username
let games = {};           
let pendingChallenges = {}; // Tracks Host -> Guest pairings

function broadcastLobbyState() {
    const usersInLobby = Object.values(connectedUsers);
    const openRooms = Object.keys(games)
        .filter(code => games[code].player2 === null)
        .map(code => ({ code, host: games[code].player1.username }));
    const activeBattles = Object.keys(games)
        .filter(code => games[code].player2 !== null)
        .map(code => ({ 
            p1: games[code].player1.username, 
            p2: games[code].player2.username 
        }));

    io.emit('lobby_state_update', { users: usersInLobby, openRooms: openRooms, activeBattles: activeBattles });
}

// --- PAYOUT LOGIC ---
async function processMatchPayout(winner, loser) {
    if (!ACTIVE_KEY) return console.log("❌ Payout Error: Active Key not set in environment.");
    const payouts = [
        { to: winner, amount: "1.900 HIVE", memo: `🏆 Victory payout vs @${loser} (Hive Battleship)` },
        { to: 'null', amount: "0.050 HIVE", memo: "🔥 Deflationary Burn (Hive Battleship)" },
        { to: 'cbrs', amount: "0.050 HIVE", memo: "🏦 Dev Fee (Hive Battleship)" }
    ];
    for (const p of payouts) {
        try {
            await client.broadcast.transfer({ from: ACCOUNT_NAME, to: p.to, amount: p.amount, memo: p.memo }, ACTIVE_KEY);
            console.log(`✅ Paid ${p.amount} to ${p.to}`);
        } catch (err) { 
            console.error(`❌ Payout failed for ${p.to}:`, err.message); 
        }
    }
}

io.on('connection', (socket) => {
    
    socket.on('register_user', (data) => {
        if (data.username) {
            connectedUsers[socket.id] = data.username.toLowerCase().trim();
            broadcastLobbyState();
        }
    });

    // --- NEW: SECURE ROOM VALIDATION ---
    socket.on('validate_room', (data) => {
        const roomCode = data.roomCode;
        
        // Check if the room exists in the 'games' object AND if it is still open (player2 is null)
        const roomExists = games[roomCode] && games[roomCode].player2 === null;
        
        // Reply instantly to the specific client who asked
        socket.emit('room_validation_result', { exists: roomExists });
    });

    socket.on('send_challenge', (data) => {
        const fromUser = data.from.toLowerCase().trim();
        const toUser = data.to.toLowerCase().trim();
        const targetSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === toUser);

        if (targetSocketId) {
            pendingChallenges[fromUser] = toUser; 
            io.to(targetSocketId).emit('receive_challenge', { from: fromUser });

            setTimeout(() => {
                if (pendingChallenges[fromUser] === toUser) {
                    delete pendingChallenges[fromUser];
                    socket.emit('challenge_expired', { to: toUser });
                    io.to(targetSocketId).emit('challenge_withdrawn', { from: fromUser });
                }
            }, 30000);
        }
    });

    socket.on('accept_challenge', (data) => {
        const hostUser = data.host.toLowerCase().trim();
        if (pendingChallenges[hostUser]) {
            const hostSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === hostUser);
            if (hostSocketId) {
                io.to(hostSocketId).emit('challenge_accepted_by_guest', { guest: data.guest });
            }
        }
    });

    socket.on('create_lobby', (data) => {
        // Generate an uppercase 5-letter room code for consistency
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        const hostName = data.username.toLowerCase().trim();
        
        games[roomCode] = {
            player1: { socket, username: hostName, board: data.board },
            player2: null, 
            currentTurn: socket.id, 
            hits: { [socket.id]: 0 }
        };
        socket.join(roomCode);
        socket.emit('lobby_created', { roomCode });

        const guestName = pendingChallenges[hostName];
        if (guestName) {
            const guestSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === guestName);
            if (guestSocketId) {
                io.to(guestSocketId).emit('challenge_room_ready', { roomCode, host: hostName });
            }
            delete pendingChallenges[hostName];
        }
        broadcastLobbyState();
    });

    socket.on('join_lobby', (data) => {
        const game = games[data.roomCode];
        if (!game || game.player2 !== null) return;
        const guestName = data.username.toLowerCase().trim();
        game.player2 = { socket, username: guestName, board: data.board };
        game.hits[socket.id] = 0;
        socket.join(data.roomCode);
        game.player1.socket.emit('match_found', { opponentName: guestName, yourTurn: true, roomId: data.roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: data.roomCode });
        broadcastLobbyState();
    });

    // --- GAMEPLAY LOGIC (RESTORED) ---
    socket.on('fire_missile', (data) => {
        const game = games[data.roomId];
        if (!game || game.currentTurn !== socket.id) return;

        const isPlayer1 = (socket.id === game.player1.socket.id);
        const defender = isPlayer1 ? game.player2 : game.player1;
        const isHit = (defender.board[data.targetIndex] !== null);
        
        io.to(data.roomId).emit('missile_result', { targetIndex: data.targetIndex, isHit, attackerId: socket.id });
        
        if (isHit) {
            game.hits[socket.id] += 1;
            if (game.hits[socket.id] >= 17) {
                const winnerName = isPlayer1 ? game.player1.username : game.player2.username;
                io.to(data.roomId).emit('game_over', { winnerId: socket.id, winnerName, loserName: defender.username });
                processMatchPayout(winnerName, defender.username);
                delete games[data.roomId];
                broadcastLobbyState();
                return;
            }
        }
        game.currentTurn = defender.socket.id;
        io.to(data.roomId).emit('turn_update', { currentTurnId: game.currentTurn });
    });

    // --- UPDATED DISCONNECT CLEANUP ---
    socket.on('disconnect', () => {
        console.log(`📡 Disconnect: ${socket.id}`);
        
        // Remove from connected users
        delete connectedUsers[socket.id];

        // Clean up any rooms associated with this socket
        for (const roomId in games) {
            const game = games[roomId];
            const isP1 = game.player1.socket.id === socket.id;
            const isP2 = game.player2 && game.player2.socket.id === socket.id;

            if (isP1 || isP2) {
                console.log(`🗑️ Removing stuck game: ${roomId}`);
                delete games[roomId];
            }
        }
        
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Battleship Server on port ${PORT}`));
