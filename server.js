const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, PrivateKey } = require('@hiveio/dhive');

const app = express();
app.use(cors());

const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
const ACCOUNT_NAME = 'cbrs'; 
const ACTIVE_KEY = process.env.HIVE_ACTIVE_KEY ? PrivateKey.fromString(process.env.HIVE_ACTIVE_KEY) : null;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let connectedUsers = {}; 
let games = {};           
let pendingChallenges = {}; 

function broadcastLobbyState() {
    const usersInLobby = Object.values(connectedUsers);
    const openRooms = Object.keys(games)
        .filter(code => games[code].player2 === null)
        .map(code => ({ code, host: games[code].player1.username }));
    const activeBattles = Object.keys(games)
        .filter(code => games[code].player2 !== null)
        .map(code => ({ p1: games[code].player1.username, p2: games[code].player2.username }));

    io.emit('lobby_state_update', { users: usersInLobby, openRooms: openRooms, activeBattles: activeBattles });
}

io.on('connection', (socket) => {
    
    socket.on('register_user', (data) => {
        if (data.username) {
            connectedUsers[socket.id] = data.username.toLowerCase().trim();
            broadcastLobbyState();
        }
    });

    // --- CHALLENGE SYSTEM WITH 30s TIMER ---
    socket.on('send_challenge', (data) => {
        const fromUser = data.from.toLowerCase().trim();
        const toUser = data.to.toLowerCase().trim();
        const targetSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id] === toUser);

        if (targetSocketId) {
            pendingChallenges[fromUser] = toUser; 
            io.to(targetSocketId).emit('receive_challenge', { from: fromUser });

            // Set 30-second timeout
            setTimeout(() => {
                if (pendingChallenges[fromUser] === toUser) {
                    delete pendingChallenges[fromUser];
                    socket.emit('challenge_expired', { to: toUser });
                    io.to(targetSocketId).emit('challenge_withdrawn', { from: fromUser });
                }
            }, 30000); // 30 seconds
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
        const roomCode = Math.random().toString(36).substring(2, 7);
        const hostName = data.username.toLowerCase().trim();
        games[roomCode] = {
            player1: { socket, username: hostName, board: data.board },
            player2: null, currentTurn: socket.id, hits: { [socket.id]: 0 }
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
        game.player2 = { socket, username: data.username.toLowerCase(), board: data.board };
        socket.join(data.roomCode);
        game.player1.socket.emit('match_found', { opponentName: data.username, yourTurn: true, roomId: data.roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: data.roomCode });
        broadcastLobbyState();
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
