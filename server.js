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

// Comma-separated list, or * for all. Default includes production Hive hub + local dev.
const socketCorsList = (process.env.SOCKET_CORS_ORIGINS || 'https://hive.coldbeetrootsoup.com,http://localhost,http://127.0.0.1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const socketCorsWildcard = socketCorsList.length === 1 && socketCorsList[0] === '*';

const socketIoCors = socketCorsWildcard
    ? { origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }
    : {
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (socketCorsList.includes(origin)) return callback(null, true);
            try {
                const host = new URL(origin).hostname;
                if (host.endsWith('.railway.app') || host.endsWith('.up.railway.app')) return callback(null, true);
                if (host.endsWith('.coldbeetrootsoup.com')) return callback(null, true);
                if (host === 'localhost' || host === '127.0.0.1') return callback(null, true);
            } catch (e) { /* ignore */ }
            callback(null, false);
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: false
    };

const io = new Server(server, { cors: socketIoCors });

// --- STATE MANAGEMENT ---
let connectedUsers = {}; 
let games = {};           
let pendingChallenges = {}; 

// GLOBAL ARCADE STATE
let globalTetrisScores = [];   
let globalInvadersScores = []; 
let globalHexabreakScores = []; 
let globalAstroScores = []; // NEW
let globalRunnerScores = [];
let globalRtypeScores = [];
let globalUpdates = []; 

// --- FETCH MASTER SAVE FILE FROM BLOCKCHAIN ---
async function loadBlockchainScores() {
    console.log("📡 Searching 'cbrs' history for the Master Leaderboards...");
    try {
        const history = await client.call('condenser_api', 'get_account_history', [ACCOUNT_NAME, -1, 1000]);
        let tetrisFound = false;
        let invadersFound = false;
        let hexabreakFound = false;
        let astroFound = false; // NEW
        let runnerFound = false;
        let rtypeFound = false;

        for (let i = history.length - 1; i >= 0; i--) {
            const op = history[i][1].op;
            if (op && op[0] === 'custom_json' && op[1].id === 'hivecade_master_leaderboard') {
                try {
                    const data = JSON.parse(op[1].json);
                    
                    if (data.game === 'tetris' && data.leaderboard && !tetrisFound) {
                        globalTetrisScores = data.leaderboard;
                        tetrisFound = true;
                    }
                    
                    if (data.game === 'invaders' && data.leaderboard && !invadersFound) {
                        globalInvadersScores = data.leaderboard;
                        invadersFound = true;
                    }

                    if (data.game === 'hexabreak' && data.leaderboard && !hexabreakFound) {
                        globalHexabreakScores = data.leaderboard;
                        hexabreakFound = true;
                    }
                    
                    if (data.game === 'astro' && data.leaderboard && !astroFound) { // NEW
                        globalAstroScores = data.leaderboard;
                        astroFound = true;
                    }

                    if (tetrisFound && invadersFound && hexabreakFound && astroFound) return;
                } catch (e) { }
            }
        }
    } catch (err) {
        console.error("❌ Failed to load blockchain scores:", err.message);
    }
}

// --- BACKUP MASTER LIST TO HIVE ---
async function saveMasterLeaderboardToHive(gameName, leaderboardData) {
    if (!ACTIVE_KEY) return;
    const op = [
        'custom_json',
        {
            required_auths: [ACCOUNT_NAME],
            required_posting_auths: [],
            id: 'hivecade_master_leaderboard',
            json: JSON.stringify({ game: gameName, leaderboard: leaderboardData })
        }
    ];
    try {
        await client.broadcast.sendOperations([op], ACTIVE_KEY);
        console.log(`💾 Master ${gameName} leaderboard backed up!`);
    } catch (err) {
        console.error(`❌ Failed to backup ${gameName}:`, err.message);
    }
}

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

async function processMatchPayout(winner, loser) {
    if (!ACTIVE_KEY) return;
    const payouts = [
        { to: winner, amount: "1.900 HIVE", memo: `🏆 Victory payout vs @${loser}` },
        { to: 'null', amount: "0.050 HIVE", memo: "🔥 Burn" },
        { to: 'cbrs', amount: "0.050 HIVE", memo: "🏦 Dev Fee" }
    ];
    for (const p of payouts) {
        try {
            await client.broadcast.transfer({ from: ACCOUNT_NAME, to: p.to, amount: p.amount, memo: p.memo }, ACTIVE_KEY);
        } catch (err) { console.error("Payout error:", err.message); }
    }
}

io.on('connection', (socket) => {
    // Initial data sync
    socket.emit('update_global_tetris_leaderboard', globalTetrisScores);
    socket.emit('update_global_invaders_leaderboard', globalInvadersScores);
    socket.emit('update_global_hexabreak_leaderboard', globalHexabreakScores); 
    socket.emit('update_global_astro_leaderboard', globalAstroScores); // NEW
    socket.emit('update_global_runner_leaderboard', globalRunnerScores);
    socket.emit('update_global_rtype_leaderboard', globalRtypeScores);
    socket.emit('receive_all_updates', globalUpdates); 

    // --- SCORE SUBMISSIONS ---
    socket.on('submit_tetris_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalTetrisScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalTetrisScores[existingIdx].score) {
                globalTetrisScores[existingIdx].score = score;
                globalTetrisScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_tetris_leaderboard', globalTetrisScores);
                saveMasterLeaderboardToHive('tetris', globalTetrisScores);
            }
        } else {
            globalTetrisScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalTetrisScores.sort((a, b) => b.score - a.score);
            globalTetrisScores = globalTetrisScores.slice(0, 10);
            io.emit('update_global_tetris_leaderboard', globalTetrisScores);
            saveMasterLeaderboardToHive('tetris', globalTetrisScores);
        }
    });

    socket.on('submit_invaders_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalInvadersScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalInvadersScores[existingIdx].score) {
                globalInvadersScores[existingIdx].score = score;
                globalInvadersScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_invaders_leaderboard', globalInvadersScores);
                saveMasterLeaderboardToHive('invaders', globalInvadersScores);
            }
        } else {
            globalInvadersScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalInvadersScores.sort((a, b) => b.score - a.score);
            globalInvadersScores = globalInvadersScores.slice(0, 10);
            io.emit('update_global_invaders_leaderboard', globalInvadersScores);
            saveMasterLeaderboardToHive('invaders', globalInvadersScores);
        }
    });

    socket.on('submit_hexabreak_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalHexabreakScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalHexabreakScores[existingIdx].score) {
                globalHexabreakScores[existingIdx].score = score;
                globalHexabreakScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_hexabreak_leaderboard', globalHexabreakScores);
                saveMasterLeaderboardToHive('hexabreak', globalHexabreakScores);
            }
        } else {
            globalHexabreakScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalHexabreakScores.sort((a, b) => b.score - a.score);
            globalHexabreakScores = globalHexabreakScores.slice(0, 10);
            io.emit('update_global_hexabreak_leaderboard', globalHexabreakScores);
            saveMasterLeaderboardToHive('hexabreak', globalHexabreakScores);
        }
    });
    
    // NEW ASTRO SUBMISSION
    socket.on('submit_astro_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalAstroScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalAstroScores[existingIdx].score) {
                globalAstroScores[existingIdx].score = score;
                globalAstroScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_astro_leaderboard', globalAstroScores);
                saveMasterLeaderboardToHive('astro', globalAstroScores);
            }
        } else {
            globalAstroScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalAstroScores.sort((a, b) => b.score - a.score);
            globalAstroScores = globalAstroScores.slice(0, 10);
            io.emit('update_global_astro_leaderboard', globalAstroScores);
            saveMasterLeaderboardToHive('astro', globalAstroScores);
        }
    });

    socket.on('submit_runner_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalRunnerScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalRunnerScores[existingIdx].score) {
                globalRunnerScores[existingIdx].score = score;
                globalRunnerScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_runner_leaderboard', globalRunnerScores);
                saveMasterLeaderboardToHive('runner', globalRunnerScores);
            }
        } else {
            globalRunnerScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalRunnerScores.sort((a, b) => b.score - a.score);
            globalRunnerScores = globalRunnerScores.slice(0, 10);
            io.emit('update_global_runner_leaderboard', globalRunnerScores);
            saveMasterLeaderboardToHive('runner', globalRunnerScores);
        }
    });

    socket.on('submit_rtype_score', (data) => {
        const { username, score } = data;
        const cleanUser = username.toLowerCase().trim();
        const existingIdx = globalRtypeScores.findIndex(s => s.username === cleanUser);
        if (existingIdx !== -1) {
            if (score > globalRtypeScores[existingIdx].score) {
                globalRtypeScores[existingIdx].score = score;
                globalRtypeScores.sort((a, b) => b.score - a.score);
                io.emit('update_global_rtype_leaderboard', globalRtypeScores);
                saveMasterLeaderboardToHive('rtype', globalRtypeScores);
            }
        } else {
            globalRtypeScores.push({ username: cleanUser, score, timestamp: Date.now() });
            globalRtypeScores.sort((a, b) => b.score - a.score);
            globalRtypeScores = globalRtypeScores.slice(0, 10);
            io.emit('update_global_rtype_leaderboard', globalRtypeScores);
            saveMasterLeaderboardToHive('rtype', globalRtypeScores);
        }
    });

    // --- UPDATES LOGIC (EDIT/DELETE) ---
    socket.on('publish_update', (data) => {
        if (data.title && data.link) {
            if (data.id) {
                const idx = globalUpdates.findIndex(u => u.id === data.id);
                if (idx !== -1) {
                    globalUpdates[idx] = { ...globalUpdates[idx], title: data.title, image: data.image, link: data.link };
                }
            } else {
                globalUpdates.unshift({
                    id: Date.now().toString(),
                    title: data.title,
                    image: data.image,
                    link: data.link,
                    timestamp: Date.now()
                });
                if (globalUpdates.length > 10) globalUpdates.pop();
            }
            io.emit('receive_all_updates', globalUpdates);
        }
    });

    socket.on('delete_update', (id) => {
        globalUpdates = globalUpdates.filter(u => u.id !== id);
        io.emit('receive_all_updates', globalUpdates);
    });

    // --- BATTLESHIP LOGIC ---
    socket.on('register_user', (data) => {
        if (data.username) {
            connectedUsers[socket.id] = data.username.toLowerCase().trim();
            broadcastLobbyState();
        }
    });

    socket.on('send_challenge', (data) => {
        const targetId = Object.keys(connectedUsers).find(id => connectedUsers[id] === data.to.toLowerCase().trim());
        if (targetId) {
            pendingChallenges[data.from.toLowerCase().trim()] = data.to.toLowerCase().trim(); 
            io.to(targetId).emit('receive_challenge', { from: data.from });
        }
    });

    socket.on('accept_challenge', (data) => {
        const hostId = Object.keys(connectedUsers).find(id => connectedUsers[id] === data.host.toLowerCase().trim());
        if (hostId) io.to(hostId).emit('challenge_accepted_by_guest', { guest: data.guest });
    });

    socket.on('create_lobby', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        games[roomCode] = {
            player1: { socket, username: data.username.toLowerCase().trim(), board: data.board },
            player2: null, currentTurn: socket.id, hits: { [socket.id]: 0 }
        };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
        broadcastLobbyState();
    });

    socket.on('join_lobby', (data) => {
        const game = games[data.roomCode];
        if (game && !game.player2) {
            game.player2 = { socket, username: data.username.toLowerCase().trim(), board: data.board };
            game.hits[socket.id] = 0;
            socket.join(data.roomCode);
            game.player1.socket.emit('match_found', { opponentName: game.player2.username, yourTurn: true, roomId: data.roomCode });
            socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: data.roomCode });
            broadcastLobbyState();
        }
    });

    socket.on('fire_missile', (data) => {
        const game = games[data.roomId];
        if (game && game.currentTurn === socket.id) {
            const defender = socket.id === game.player1.socket.id ? game.player2 : game.player1;
            const isHit = defender.board[data.targetIndex] !== null;
            io.to(data.roomId).emit('missile_result', { targetIndex: data.targetIndex, isHit, attackerId: socket.id });
            if (isHit) {
                game.hits[socket.id]++;
                if (game.hits[socket.id] >= 17) {
                    io.to(data.roomId).emit('game_over', { winnerId: socket.id, winnerName: socket.id === game.player1.socket.id ? game.player1.username : game.player2.username });
                    processMatchPayout(connectedUsers[socket.id], defender.username);
                    delete games[data.roomId];
                    broadcastLobbyState();
                    return;
                }
            }
            game.currentTurn = defender.socket.id;
            io.to(data.roomId).emit('turn_update', { currentTurnId: game.currentTurn });
        }
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        broadcastLobbyState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { // <--- ADD "0.0.0.0" HERE
    console.log(`🚀 Server on port ${PORT}`);
});