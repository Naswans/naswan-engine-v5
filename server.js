const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const io = require('socket.io')(server);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

io.on('connection', (socket) => {
    socket.on('join', ({ room, name }) => {
        if (!rooms[room]) rooms[room] = { players: [], host: socket.id };
        socket.join(room);
        rooms[room].players.push({ id: socket.id, name });
        io.to(room).emit('update', rooms[room]);
    });

    socket.on('kick', ({ room, targetId }) => {
        if (rooms[room] && rooms[room].host === socket.id) {
            io.to(targetId).emit('kicked');
            rooms[room].players = rooms[room].players.filter(p => p.id !== targetId);
            io.to(room).emit('update', rooms[room]);
        }
    });

    // Voice signaling
    socket.on('voice-signal', (data) => socket.to(data.room).emit('voice-peer', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Naswan Engine V5 running on port ${PORT}`));