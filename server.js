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