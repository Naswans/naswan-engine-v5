const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let players = {}; 
let hostId = null; // Melacak siapa yang memegang kendali
let game = {
    status: 'LOBBY', 
    word: '',
    turnIndex: 0,
    timer: 30,
    clueHistory: [],
    votes: {},
    timerInterval: null
};

const wordBank = ['KANCIL', 'ROBOT', 'INTERNET', 'SATELIT', 'PIZZA', 'MASKER', 'KAMERA', 'KAPAL', 'DRONE', 'SAHAM'];

function broadcast(event, data) { io.emit(event, data); }

function updateGameState() {
    const aliveIds = Object.keys(players).filter(id => players[id].isAlive);
    broadcast('game_state_update', {
        status: game.status,
        turnPlayer: aliveIds[game.turnIndex],
        clueHistory: game.clueHistory,
        hostId: hostId,
        alivePlayers: aliveIds.map(id => ({ 
            id, 
            username: players[id].username,
            voteCount: Object.values(game.votes).filter(v => v === id).length,
            isHost: id === hostId
        }))
    });
}

function startRound() {
    const ids = Object.keys(players).filter(id => players[id].isAlive);
    if (ids.length < 3) return; // Minimal 3 untuk keseruan

    game.status = 'PLAYING';
    game.word = wordBank[Math.floor(Math.random() * wordBank.length)];
    game.clueHistory = [];
    game.votes = {};
    game.turnIndex = 0;

    // Logika Rasio 4:1 (20 pemain = 4 Impostor)
    const impostorCount = Math.max(1, Math.floor(ids.length / 5));
    const shuffledIds = [...ids].sort(() => 0.5 - Math.random());
    const impostors = shuffledIds.slice(0, impostorCount);

    ids.forEach((id) => {
        const isImpostor = impostors.includes(id);
        players[id].role = isImpostor ? 'IMPOSTOR' : 'CREWMATE';
        players[id].cluesSent = 0;
        
        io.to(id).emit('role_reveal', {
            role: players[id].role,
            word: isImpostor ? '🤫 KELABUI MEREKA!' : game.word,
            impostorPartners: isImpostor ? impostors.map(impId => players[impId].username) : []
        });
    });

    updateGameState();
    resetTimer(30);
}

function resetTimer(seconds) {
    if (game.timerInterval) clearInterval(game.timerInterval);
    game.timer = seconds;
    broadcast('timer_sync', game.timer);
    game.timerInterval = setInterval(() => {
        game.timer--;
        broadcast('timer_sync', game.timer);
        if (game.timer <= 0) {
            clearInterval(game.timerInterval);
            if (game.status === 'PLAYING') handleTimeout();
            else if (game.status === 'VOTING') processElimination();
        }
    }, 1000);
}

function handleTimeout() {
    const aliveIds = Object.keys(players).filter(id => players[id].isAlive);
    const currentId = aliveIds[game.turnIndex];
    if (currentId) {
        players[currentId].cluesSent++;
        game.clueHistory.push({ user: "SYSTEM", text: `${players[currentId].username} AFK/Melewatkan Giliran.` });
    }
    moveToNextTurn();
}

function moveToNextTurn() {
    const aliveIds = Object.keys(players).filter(id => players[id].isAlive);
    const allDone = aliveIds.every(id => players[id].cluesSent >= 2);

    if (allDone) {
        game.status = 'VOTING';
        updateGameState();
        resetTimer(45);
    } else {
        game.turnIndex = (game.turnIndex + 1) % aliveIds.length;
        updateGameState();
        resetTimer(30);
    }
}

function processElimination() {
    const voteCounts = {};
    Object.values(game.votes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let eliminatedId = null;
    let maxVotes = 0;
    const votesArray = Object.entries(voteCounts);
    
    if (votesArray.length > 0) {
        votesArray.sort((a,b) => b[1] - a[1]);
        if (votesArray.length === 1 || votesArray[0][1] > votesArray[1][1]) {
            eliminatedId = votesArray[0][0];
        }
    }

    if (eliminatedId) {
        players[eliminatedId].isAlive = false;
        broadcast('receive_chat', { 
            user: 'PENGUMUMAN', 
            msg: `🚨 ${players[eliminatedId].username} DIELIMINASI! Role: ${players[eliminatedId].role}` 
        });
    } else {
        broadcast('receive_chat', { user: 'PENGUMUMAN', msg: "🗳️ Hasil voting seri! Tidak ada eliminasi." });
    }
    
    checkVictoryConditions();
}

function checkVictoryConditions() {
    const alive = Object.values(players).filter(p => p.isAlive);
    const impostors = alive.filter(p => p.role === 'IMPOSTOR');
    const crewmates = alive.filter(p => p.role === 'CREWMATE');

    if (impostors.length === 0) {
        endGame("CREWMATE MENANG! 🎉 Semua Impostor tertangkap.");
    } else if (impostors.length >= crewmates.length) {
        endGame("IMPOSTOR MENANG! 😈 Crewmate kalah jumlah.");
    } else {
        setTimeout(startRound, 4000);
    }
}

function endGame(result) {
    game.status = 'LOBBY';
    broadcast('game_over', result);
    Object.keys(players).forEach(id => players[id].isAlive = true);
    updateGameState();
}

io.on('connection', (socket) => {
    socket.on('join_game', (username) => {
        // Pemain pertama jadi Host
        if (!hostId) hostId = socket.id;

        players[socket.id] = { id: socket.id, username, role: '', cluesSent: 0, isAlive: true };
        updateGameState();
        broadcast('receive_chat', { user: 'SYSTEM', msg: `${username} bergabung ke lobby.` });
    });

    socket.on('start_game_request', () => {
        if (socket.id === hostId && game.status === 'LOBBY') {
            if (Object.keys(players).length >= 3) startRound();
            else socket.emit('receive_chat', { user: 'SYSTEM', msg: "Butuh minimal 3 pemain!" });
        }
    });

    socket.on('send_description', (text) => {
        const aliveIds = Object.keys(players).filter(id => players[id].isAlive);
        if (socket.id !== aliveIds[game.turnIndex] || game.status !== 'PLAYING') return;
        players[socket.id].cluesSent++;
        game.clueHistory.push({ user: players[socket.id].username, text });
        moveToNextTurn();
    });

    socket.on('cast_vote', (targetId) => {
        if (game.status === 'VOTING' && players[socket.id].isAlive) {
            game.votes[socket.id] = targetId;
            updateGameState();
        }
    });

    socket.on('free_chat', (msg) => {
        if (players[socket.id]) broadcast('receive_chat', { user: players[socket.id].username, msg });
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const name = players[socket.id].username;
            delete players[socket.id];
            
            // Pindahkan Host jika host asli keluar
            if (socket.id === hostId) {
                const remaining = Object.keys(players);
                hostId = remaining.length > 0 ? remaining[0] : null;
            }

            if (Object.keys(players).length < 2) game.status = 'LOBBY';
            broadcast('receive_chat', { user: 'SYSTEM', msg: `${name} meninggalkan permainan.` });
            updateGameState();
        }
    });
});

http.listen(3000, () => console.log(`🚀 ENGINE AKTIF DI PORT 3000`));
