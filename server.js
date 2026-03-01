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

// GLOBAL TETRIS ARCADE STATE
let globalTetrisScores = []; // Holds { username, score, timestamp }

// --- NEW: FETCH SCORES FROM BLOCKCHAIN ON STARTUP ---
async function loadBlockchainScores() {
    console.log("📡 Scanning Hive Blockchain for permanent Tetris scores...");
    try {
        // Fetch the last 1000 operations from the hub account
        const history = await client.call('condenser_api', 'get_account_history', [ACCOUNT_NAME, -1, 1000]);
        let scoresMap = {};

        history.forEach(item => {
            const op = item[1].op;
            // Look for our specific game save data
            if (op[0] === 'custom_json' && op[1].id === 'hivecade_score') {
                try {
                    const data = JSON.parse(op[1].json);
                    if (data.game === 'tetris') {
                        const user = op[1].required_posting_auths[0];
                        const score = parseInt(data.score);

                        // Only keep the highest score per user
                        if (!scoresMap[user] || score > scoresMap[user]) {
                            scoresMap[user] = score;
                        }
                    }
                } catch (e) {
                    // Ignore malformed JSON
                }
            }
        });

        // Convert the map back to our sorted array format
        globalTetrisScores = Object.keys(scoresMap).map(user => ({
            username: user,
            score: scoresMap[user],
            timestamp: Date.now() // Treat as fresh
        })).sort((a, b) => b.score - a.score).slice(0, 10);

        console.log(`✅ Successfully loaded ${globalTetrisScores.length} global scores from the blockchain!`);
    } catch (err) {
        console.error("❌ Failed to load blockchain scores:", err.message);
    }
}

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
    console.log(`📡 New Connection: ${socket.id}`);

    // --- ARCADE LOGIC ---
    // Send current leaderboard immediately upon connection
    socket.emit('update_global_tetris_leaderboard', globalTetrisScores);

    socket.on('submit_tetris_score', (data) => {
        const { username, score } = data;
        if (!username || typeof score !== 'number') return;

        const cleanUser = username.toLowerCase().trim();
        console.log(`🧩 Tetris Submission: @${cleanUser} scored ${score}`);

        // Update existing or add new
        const existingIdx = globalTetrisScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalTetrisScores[existingIdx].score) {
                globalTetrisScores[existingIdx].score = score;
                globalTetrisScores[existingIdx].timestamp = Date.now();
            }
        } else {
            globalTetrisScores.push({ username: cleanUser, score: score, timestamp: Date.now() });
        }

        // Sort Top 10 and broadcast
        globalTetrisScores.sort((a, b) => b.score - a.score);
        globalTetrisScores = globalTetrisScores.slice(0, 10);
        
        io.emit('update_global_tetris_leaderboard', globalTetrisScores);
    });

    // --- BATTLESHIP LOGIC ---
    socket.on('register_user', (data) => {
        if (data.username) {
            connectedUsers[socket.id] = data.username.toLowerCase().trim();
            broadcastLobbyState();
        }
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

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        for (const roomId in games) {
            const game = games[roomId];
            if (game.player1.socket.id === socket.id || (game.player2 && game.player2.socket.id === socket.id)) {
                delete games[roomId];
            }
        }
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 Hivecade Global Server on port ${PORT}`);
    // Boot up sequence: Load the permanent scores!
    await loadBlockchainScores(); 
});
