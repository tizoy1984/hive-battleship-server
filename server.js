require('dotenv').config(); // Loads secret variables
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, PrivateKey } = require('@hiveio/dhive');

// --- HIVE BLOCKCHAIN SETUP ---
const hiveClient = new Client(['https://api.hive.blog', 'https://api.deathwing.me']);
const BANK_ACCOUNT = 'cbrs';
// This pulls the secret key from Render's secure vault:
const BANK_ACTIVE_KEY = process.env.HIVE_ACTIVE_KEY; 

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let waitingPlayer = null; 
let games = {};           

// --- PAYOUT FUNCTION ---
async function payWinner(winnerName, amount, roomId) {
    try {
        if (!BANK_ACTIVE_KEY) {
            console.error("🚨 ERROR: HIVE_ACTIVE_KEY is missing in Render environment variables!");
            return false;
        }
        
        const key = PrivateKey.fromString(BANK_ACTIVE_KEY);
        const op = [
            'transfer',
            {
                from: BANK_ACCOUNT,
                to: winnerName,
                amount: `${amount.toFixed(3)} HIVE`, // Must be formatted as "2.000 HIVE"
                memo: `🏆 Hive Battleship Victory! Winnings from room: ${roomId}`
            }
        ];
        
        await hiveClient.broadcast.sendOperations([op], key);
        console.log(`💰 SUCCESS: Paid ${amount} HIVE to @${winnerName}`);
        return true;
    } catch (error) {
        console.error("❌ Payout failed:", error.message);
        return false;
    }
}

io.on('connection', (socket) => {
    console.log(`🟢 Speler verbonden: ${socket.id}`);

    // --- CUSTOM LOBBY LOGIC ---
    socket.on('create_lobby', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 7);
        const playerObj = { socket: socket, username: data.username, board: data.board };

        games[roomCode] = {
            player1: playerObj,
            player2: null,
            currentTurn: socket.id,
            hits: { [socket.id]: 0 },
            pot: 2.000 // 2 HIVE pot!
        };

        socket.join(roomCode);
        socket.emit('lobby_created', { roomCode: roomCode });
        console.log(`🏠 Lobby created: ${roomCode} by ${data.username}`);
    });

    socket.on('join_lobby', (data) => {
        const { username, board, roomCode } = data;
        const game = games[roomCode];

        if (!game) return socket.emit('lobby_error', { message: "Room not found!" });
        if (game.player2 !== null) return socket.emit('lobby_error', { message: "Room is already full!" });

        const playerObj = { socket: socket, username: username, board: board };
        game.player2 = playerObj;
        game.hits[socket.id] = 0; 

        socket.join(roomCode);
        game.player1.socket.emit('match_found', { opponentName: playerObj.username, yourTurn: true, roomId: roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: roomCode });
        console.log(`⚔️ Match started in lobby ${roomCode}!`);
    });

    // --- GAMEPLAY LOGIC ---
    socket.on('fire_missile', (data) => {
        const { roomId, targetIndex } = data;
        const game = games[roomId];
        if (!game) return;
        if (game.currentTurn !== socket.id) return;

        const isPlayer1 = (socket.id === game.player1.socket.id);
        const attacker = isPlayer1 ? game.player1 : game.player2;
        const defender = isPlayer1 ? game.player2 : game.player1;

        const hitShip = defender.board[targetIndex];
        const isHit = (hitShip !== null);

        io.to(roomId).emit('missile_result', { targetIndex: targetIndex, isHit: isHit, attackerId: socket.id });

        if (isHit) {
            game.hits[socket.id] += 1; 
            
            if (game.hits[socket.id] >= 17) {
                console.log(`🏆 GAME OVER! ${attacker.username} won! Initiating payout...`);
                
                // Trigger the automatic blockchain payout!
                payWinner(attacker.username, game.pot, roomId);

                io.to(roomId).emit('game_over', {
                    winnerId: socket.id,
                    winnerName: attacker.username,
                    loserName: defender.username
                });
                
                delete games[roomId];
                return; 
            }
        }

        game.currentTurn = defender.socket.id;
        io.to(roomId).emit('turn_update', { currentTurnId: game.currentTurn });
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Speler vertrokken: ${socket.id}`);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Battleship Server draait op http://localhost:${PORT}`);
});




