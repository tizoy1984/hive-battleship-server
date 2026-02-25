const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let waitingPlayer = null; 
let games = {};           

io.on('connection', (socket) => {
    console.log(`🟢 Speler verbonden: ${socket.id}`);

    // --- NEW: CUSTOM LOBBY LOGIC ---
    
    // 1. Player creates a private room
    socket.on('create_lobby', (data) => {
        // Generate a random 5-character room code (e.g., "x7y9a")
        const roomCode = Math.random().toString(36).substring(2, 7);
        
        const playerObj = {
            socket: socket,
            username: data.username,
            board: data.board 
        };

        // Create a new game room in memory, waiting for Player 2
        games[roomCode] = {
            player1: playerObj,
            player2: null, // Empty for now!
            currentTurn: socket.id,
            hits: { [socket.id]: 0 }
        };

        socket.join(roomCode);
        
        // Tell the creator their room code so they can share it
        socket.emit('lobby_created', { roomCode: roomCode });
        console.log(`🏠 Lobby created: ${roomCode} by ${data.username}`);
    });

    // 2. Player 2 joins using the code
    socket.on('join_lobby', (data) => {
        const { username, board, roomCode } = data;
        const game = games[roomCode];

        // Check if the room exists and isn't full
        if (!game) {
            socket.emit('lobby_error', { message: "Room not found!" });
            return;
        }
        if (game.player2 !== null) {
            socket.emit('lobby_error', { message: "Room is already full!" });
            return;
        }

        // Add Player 2 to the game
        const playerObj = {
            socket: socket,
            username: username,
            board: board 
        };

        game.player2 = playerObj;
        game.hits[socket.id] = 0; // Initialize Player 2's score

        socket.join(roomCode);

        // Start the game for both players!
        game.player1.socket.emit('match_found', { opponentName: playerObj.username, yourTurn: true, roomId: roomCode });
        socket.emit('match_found', { opponentName: game.player1.username, yourTurn: false, roomId: roomCode });
        
        console.log(`⚔️ Match started in lobby ${roomCode}!`);
    });
    // --- END OF CUSTOM LOBBY LOGIC ---

    socket.on('find_match', (data) => {
        const playerObj = {
            socket: socket,
            username: data.username,
            board: data.board 
        };

        if (waitingPlayer === null) {
            waitingPlayer = playerObj;
        } else {
            const roomId = `game_${waitingPlayer.socket.id}_${socket.id}`;
            waitingPlayer.socket.join(roomId);
            socket.join(roomId);

            games[roomId] = {
                player1: waitingPlayer,
                player2: playerObj,
                currentTurn: waitingPlayer.socket.id,
                // NEW: Score trackers!
                hits: {
                    [waitingPlayer.socket.id]: 0,
                    [socket.id]: 0
                }
            };

            waitingPlayer.socket.emit('match_found', { opponentName: playerObj.username, yourTurn: true, roomId: roomId });
            socket.emit('match_found', { opponentName: waitingPlayer.username, yourTurn: false, roomId: roomId });

            waitingPlayer = null;
        }
    });

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

        io.to(roomId).emit('missile_result', {
            targetIndex: targetIndex,
            isHit: isHit,
            attackerId: socket.id
        });

        // NEW: Check for Game Over!
        if (isHit) {
            game.hits[socket.id] += 1; // Add 1 to the attacker's score
            
            if (game.hits[socket.id] >= 17) {
                // WE HAVE A WINNER!
                console.log(`🏆 GAME OVER! ${attacker.username} won the match!`);
                io.to(roomId).emit('game_over', {
                    winnerId: socket.id,
                    winnerName: attacker.username,
                    loserName: defender.username
                });
                
                // Clean up the room so it doesn't stay in the server's memory forever
                delete games[roomId];
                return; // Stop the code here so the turn doesn't swap
            }
        }

        // Change turns (Only happens if the game is NOT over)
        game.currentTurn = defender.socket.id;
        io.to(roomId).emit('turn_update', { currentTurnId: game.currentTurn });
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Speler vertrokken: ${socket.id}`);
        if (waitingPlayer && waitingPlayer.socket === socket) waitingPlayer = null;
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Battleship Server draait op http://localhost:${PORT}`);
});
