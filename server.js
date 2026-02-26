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
let pendingChallenges = {}; // Tracks Host -> Guest mapping

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

    io.emit('lobby_state_update', {
        users: usersInLobby,
        openRooms: openRooms,
        activeBattles: activeBattles
    });
}

io.on('connection', (socket) => {
    
    // CRITICAL: Ensure users are registered
    socket.on('register_user', (data) => {
        if (data.username) {
            connectedUsers[socket.id] = data.username.toLowerCase();
            console.log(`👤 User Registered: ${data.username} on socket ${socket.id}`);
            broadcastLobbyState();
        }
    });

    // --- CHALLENGE SYSTEM LOGIC ---
    socket.on('send_challenge', (data) => {
        const targetUser = data.to.toLowerCase();
        // Find the specific socket ID for the target username
        const targetSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === targetUser);
        
        console.log(`⚔️ Attempting Challenge: From ${data.from} to ${targetUser}`);
        
        if (targetSocketId) {
            pendingChallenges[data.from.toLowerCase()] = targetUser; 
            io.to(targetSocketId).emit('receive_challenge', { from: data.from });
            console.log(`✅ Challenge Delivered to socket: ${targetSocketId}`);
        } else {
            console.log(`❌ Challenge Failed: No active socket found for @${targetUser}`);
            socket.emit('lobby_error', { message: `Commander @${targetUser} is offline or not registered.` });
        }
    });

    socket.on('accept_challenge', (data) => {
        const hostUser = data.host.toLowerCase();
        const hostSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === hostUser);
        if (hostSocketId) {
            io.to(hostSocketId).emit('challenge_accepted_by_guest', { guest: data.guest });
        }
    });

    socket.on('create_lobby', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 7);
        games[roomCode] = {
            player1: { socket, username: data.username, board: data.board },
            player2: null, 
            currentTurn: socket.id, 
            hits: { [socket.id]: 0 }
        };
        socket.join(roomCode);
        socket.emit('lobby_created', { roomCode });

        const guestName = pendingChallenges[data.username.toLowerCase()];
        if (guestName) {
            const guestSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === guestName);
            if (guestSocketId) {
                io.to(guestSocketId).emit('challenge_room_ready', { roomCode, host: data.username });
            }
            delete pendingChallenges[data.username.toLowerCase()];
        }
        broadcastLobbyState();
    });

    socket.on('join_lobby', (data) => {
        const game = games[data.roomCode];
        if (!game || game.player2 !== null) return;
        game.player2 = { socket, username: data.username, board: data.board };
        game.hits[socket.id] = 0;
        socket.join(data.roomCode);
        game.player1.socket.emit('match_found', { opponentName: data.username, yourTurn: true, roomId: data.roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: data.roomCode });
        broadcastLobbyState();
    });

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
                io.to(data.roomId).emit('game_over', { winnerId: socket.id, winnerName: (isPlayer1 ? game.player1.username : game.player2.username), loserName: defender.username });
                delete games[data.roomId];
                broadcastLobbyState();
                return;
            }
        }
        game.currentTurn = defender.socket.id;
        io.to(data.roomId).emit('turn_update', { currentTurnId: game.currentTurn });
    });

    socket.on('disconnect', () => {
        console.log(`📡 Disconnect: ${socket.id} (@${connectedUsers[socket.id]})`);
        delete connectedUsers[socket.id];
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Battleship Server running on port ${PORT}`));
