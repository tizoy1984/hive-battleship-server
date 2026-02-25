document.addEventListener('DOMContentLoaded', () => {

    // --- 1. URL CHECKER (Auto-fill Room Code) ---
    function checkUrlForRoom() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomFromUrl = urlParams.get('room'); 
        
        if (roomFromUrl) {
            console.log(`🔗 Link detected! Room code: ${roomFromUrl}`);
            const joinInput = document.getElementById('join-code-input');
            if (joinInput) {
                joinInput.value = roomFromUrl;
            }
        }
    }
    // Run immediately when page loads
    checkUrlForRoom();

    // --- 2. HIVE KEYCHAIN LOGIN ---
    const btnLogin = document.getElementById('btn-login');
    const usernameInput = document.getElementById('hive-username');
    const loginSection = document.getElementById('login-section');
    const userProfile = document.getElementById('user-profile');

    let loggedInPlayer = null;

    if (btnLogin) {
        btnLogin.addEventListener('click', () => {
            const username = usernameInput.value.trim().toLowerCase();
            if (!username) return alert('Please enter your Hive username first.');

            if (window.hive_keychain) {
                const loginMessage = `Login to Hive Battleship: ${Date.now()}`;
                window.hive_keychain.requestSignBuffer(username, loginMessage, 'Posting', (response) => {
                    if (response.success) {
                        loggedInPlayer = username;
                        loginSection.style.display = 'none';
                        userProfile.innerText = `👤 @${username}`;
                        userProfile.style.display = 'block';
                        console.log("Authentication successful!");
                    } else {
                        alert('Login failed: ' + response.message);
                    }
                });
            } else {
                alert('Hive Keychain is not installed!');
            }
        });
    }

    // --- 3. GAME STATE ---
    const shipsToPlace = [
        { name: 'Carrier', size: 5 },
        { name: 'Battleship', size: 4 },
        { name: 'Cruiser', size: 3 },
        { name: 'Submarine', size: 3 },
        { name: 'Destroyer', size: 2 }
    ];

    let currentShipIndex = 0;
    let isHorizontal = true;
    let playerGridState = new Array(100).fill(null);
    let socket;
    let currentRoomId = null;

    // --- 4. UI ELEMENTS ---
    const rotateBtn = document.getElementById('btn-rotate');
    const instructions = document.getElementById('game-instructions');

    // --- 5. BOARD GENERATION ---
    function createBoard(boardId) {
        const boardElement = document.getElementById(boardId);
        if (!boardElement) return;

        for (let i = 0; i < 100; i++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.index = i;

            if (boardId === 'player-board') {
                cell.addEventListener('click', () => handleShipPlacement(i));
            } else if (boardId === 'enemy-board') {
                cell.addEventListener('click', () => {
                    if (currentRoomId) {
                        socket.emit('fire_missile', { roomId: currentRoomId, targetIndex: i });
                    }
                });
            }
            boardElement.appendChild(cell);
        }
    }

    // --- 6. PLACEMENT LOGIC ---
    function handleShipPlacement(startIndex) {
        if (currentShipIndex >= shipsToPlace.length) return;

        const ship = shipsToPlace[currentShipIndex];
        const targetCells = [];

        for (let i = 0; i < ship.size; i++) {
            if (isHorizontal) {
                const currentRow = Math.floor(startIndex / 10);
                const targetRow = Math.floor((startIndex + i) / 10);
                if (currentRow !== targetRow) return showError(startIndex);
                targetCells.push(startIndex + i);
            } else {
                const targetIndex = startIndex + (i * 10);
                if (targetIndex >= 100) return showError(startIndex);
                targetCells.push(targetIndex);
            }
        }

        const hasCollision = targetCells.some(index => playerGridState[index] !== null);
        if (hasCollision) return showError(startIndex);

        targetCells.forEach(index => {
            playerGridState[index] = ship.name;
            const cellElement = document.querySelector(`#player-board .cell[data-index="${index}"]`);
            if (cellElement) cellElement.classList.add('ship');
        });

        const badge = document.getElementById(`ship-${ship.name}`);
        if (badge) {
            badge.classList.remove('active');
            badge.classList.add('placed');
        }

        currentShipIndex++;

        if (currentShipIndex < shipsToPlace.length) {
            const nextShip = shipsToPlace[currentShipIndex];
            const nextBadge = document.getElementById(`ship-${nextShip.name}`);
            if (nextBadge) nextBadge.classList.add('active');
            if (instructions) instructions.innerText = `Place your ${nextShip.name} (${nextShip.size} blocks).`;
        } else {
            // ALL SHIPS PLACED!
            if (instructions) {
                instructions.innerText = "Fleet deployed! Connecting to headquarters... 📡";
                instructions.style.color = "#0ea5e9";
            }
            const setupControls = document.getElementById('setup-controls');
            if (setupControls) setupControls.style.display = 'none';

            // Start connection to server
            connectToServer();
        }
    }

    function showError(index) {
        const cell = document.querySelector(`#player-board .cell[data-index="${index}"]`);
        if (cell) {
            cell.classList.add('error');
            setTimeout(() => cell.classList.remove('error'), 300);
        }
    }

    if (rotateBtn) {
        rotateBtn.addEventListener('click', () => {
            isHorizontal = !isHorizontal;
            rotateBtn.innerText = isHorizontal ? "🔄 Orientation: Horizontal" : "🔄 Orientation: Vertical";
        });
    }

    // --- 7. MULTIPLAYER CONNECTION & LOBBY LOGIC ---
    function connectToServer() {
        if (!loggedInPlayer) {
            alert("Error: You must login with Hive Keychain first!");
            return;
        }

        if (typeof io === 'undefined') {
            alert("⚠️ Cannot connect! Make sure the socket.io script is in your index.html!");
            return;
        }

        // Connect to your Node server
        socket = io('https://hive-battleship-server.onrender.com');

        socket.on('connect', () => {
            console.log("Connected to server! My ID is:", socket.id);
            
            // Show the Lobby Menu now that we are connected
            const lobbyMenu = document.getElementById('lobby-menu');
            if (lobbyMenu) lobbyMenu.style.display = 'block';

            if (instructions) {
                instructions.innerText = "Connected! Create or Join a Custom Game.";
                instructions.style.color = "#10b981";
            }

            // AUTO-JOIN LOGIC: If they clicked a shared link, join immediately
            const urlParams = new URLSearchParams(window.location.search);
            const roomFromUrl = urlParams.get('room');
            if (roomFromUrl) {
                socket.emit('join_lobby', {
                    username: loggedInPlayer,
                    board: playerGridState,
                    roomCode: roomFromUrl
                });
            }
        });

        // LOBBY: Successfully created a room
        socket.on('lobby_created', (data) => {
            document.getElementById('share-link-container').style.display = 'block';
            
            // Generate full clickable link
            const currentUrl = window.location.origin + window.location.pathname;
            const fullShareLink = `${currentUrl}?room=${data.roomCode}`;
            
            const displayElement = document.getElementById('room-code-display');
            displayElement.innerText = fullShareLink;
            displayElement.style.fontSize = "16px";
            displayElement.style.wordBreak = "break-all";
            
            if (instructions) instructions.innerText = "Waiting for opponent to join...";
        });

        // LOBBY: Error joining room
        socket.on('lobby_error', (data) => {
            const errorEl = document.getElementById('lobby-error-message');
            if(errorEl) {
                errorEl.innerText = data.message;
                errorEl.style.display = 'block';
            }
        });

        // MATCHMAKER: Game starts!
        socket.on('match_found', (data) => {
            console.log("Match found tegen:", data.opponentName);
            currentRoomId = data.roomId; 
            
            // Hide the lobby menu
            const lobbyMenu = document.getElementById('lobby-menu');
            if (lobbyMenu) lobbyMenu.style.display = 'none';

            const status = document.getElementById('game-status');
            if (status) status.innerText = `Battle: You vs @${data.opponentName}`;
            
            updateTurnUI(data.yourTurn);
        });

        // GAMEPLAY: Missile results
        socket.on('missile_result', (data) => {
            const { targetIndex, isHit, attackerId } = data;
            const amIAttacker = (attackerId === socket.id);

            if (amIAttacker) {
                const cell = document.querySelector(`#enemy-board .cell[data-index="${targetIndex}"]`);
                if (cell) {
                    cell.style.backgroundColor = isHit ? 'var(--hive-red)' : '#ffffff';
                    cell.style.pointerEvents = 'none'; 
                }
            } else {
                const cell = document.querySelector(`#player-board .cell[data-index="${targetIndex}"]`);
                if (cell) {
                    cell.style.backgroundColor = isHit ? 'var(--hive-red)' : '#ffffff';
                    cell.innerText = isHit ? '💥' : '💦'; 
                    cell.style.display = 'flex';
                    cell.style.alignItems = 'center';
                    cell.style.justifyContent = 'center';
                    cell.style.fontSize = '20px';
                }
            }
        });

        // GAMEPLAY: Turn update
        socket.on('turn_update', (data) => {
            const isMyTurn = (data.currentTurnId === socket.id);
            updateTurnUI(isMyTurn);
        });

        // GAME OVER & BLOCKCHAIN
        socket.on('game_over', (data) => {
            const { winnerId, winnerName, loserName } = data;
            const amIWinner = (winnerId === socket.id);
            
            const status = document.getElementById('game-status');
            const enemySection = document.getElementById('enemy-section');

            if (enemySection) {
                enemySection.style.opacity = '0.4';
                enemySection.style.pointerEvents = 'none';
            }

            if (amIWinner) {
                if (status) status.innerText = `🏆 VICTORY! You defeated @${loserName}!`;
                if (instructions) {
                    instructions.innerText = "Congratulations! Broadcasting win to Hive... ⛓️";
                    instructions.style.color = "#10b981"; 
                }
                
                if (window.hive_keychain) {
                    const gameData = {
                        game: "hive-battleship",
                        action: "match_result",
                        winner: winnerName,
                        loser: loserName,
                        timestamp: Date.now()
                    };

                    window.hive_keychain.requestCustomJson(
                        winnerName, 
                        "battleship_result", 
                        "Posting", 
                        JSON.stringify(gameData), 
                        "Record Victory on Blockchain", 
                        (response) => {
                            if (response.success) {
                                if (instructions) instructions.innerText = "✅ Victory permanently recorded on the Hive Blockchain!";
                            } else {
                                if (instructions) {
                                    instructions.innerText = "❌ Broadcast canceled.";
                                    instructions.style.color = "var(--hive-red)";
                                }
                            }
                        }
                    );
                }

            } else {
                if (status) status.innerText = `💀 DEFEAT. @${winnerName} destroyed your fleet.`;
                if (instructions) {
                    instructions.innerText = "Your fleet is at the bottom of the ocean.";
                    instructions.style.color = "var(--hive-red)";
                }
            }
        });
    }

    function updateTurnUI(isMyTurn) {
        const enemySection = document.getElementById('enemy-section');
        if (isMyTurn) {
            if (instructions) {
                instructions.innerText = "🚨 It's your turn! Fire a missile.";
                instructions.style.color = "var(--hive-red)";
            }
            if (enemySection) {
                enemySection.style.opacity = '1';
                enemySection.style.pointerEvents = 'auto';
            }
        } else {
            if (instructions) {
                instructions.innerText = "⏳ Waiting for opponent to fire...";
                instructions.style.color = "var(--text-muted)";
            }
            if (enemySection) {
                enemySection.style.opacity = '0.4';
                enemySection.style.pointerEvents = 'none';
            }
        }
    }

    // --- 8. LOBBY BUTTON FUNCTIONS (Attached to Window) ---
    // We attach these to 'window' so your HTML <button onclick="..."> can find them!
    window.createPrivateLobby = function() {
        if (!socket) return;
        socket.emit('create_lobby', {
            username: loggedInPlayer, 
            board: playerGridState 
        });
        
        document.getElementById('btn-create-lobby').disabled = true;
        document.getElementById('btn-join-lobby').disabled = true;
    };

    window.joinPrivateLobby = function() {
        if (!socket) return;
        const codeInput = document.getElementById('join-code-input').value.trim();
        
        if(codeInput.length === 0) {
            const errorEl = document.getElementById('lobby-error-message');
            if(errorEl) {
                errorEl.innerText = "Please enter a room code.";
                errorEl.style.display = 'block';
            }
            return;
        }

        socket.emit('join_lobby', {
            username: loggedInPlayer,
            board: playerGridState,
            roomCode: codeInput
        });
    };

    // Initialize the visual boards
    createBoard('player-board');
    createBoard('enemy-board');
});
