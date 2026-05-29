import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { GameManager } from './gameManager.js';

// Инициализация Express приложения
const app = express();
const server = http.createServer(app);

// Socket.IO сервер с CORS поддержкой
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Менеджер игр (управляет всеми комнатами и состояниями)
const gameManager = new GameManager(io);

// REST API эндпоинты
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Socket.IO события
io.on('connection', (socket) => {
  console.log('Новый игрок подключился:', socket.id);

  // Событие: создание новой комнаты
  socket.on('createRoom', (playerName, callback) => {
    try {
      const { roomCode, playerId } = gameManager.createRoom(playerName, socket.id);
      socket.join(roomCode);
      
      // Отправляем данные игроку
      callback({
        success: true,
        roomCode,
        playerId,
        players: gameManager.getRoom(roomCode)?.players || [],
      });

      // Уведомляем всех в комнате об обновлении списка игроков
      io.to(roomCode).emit('playersUpdated', gameManager.getRoom(roomCode)?.players || []);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: присоединение к существующей комнате
  socket.on('joinRoom', (roomCode, playerName, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      if (!room) {
        return callback({ success: false, error: 'Комната не найдена' });
      }

      if (room.players.length >= 10) {
        return callback({ success: false, error: 'Комната переполнена' });
      }

      if (room.gameState !== 'waiting') {
        return callback({ success: false, error: 'Игра уже началась' });
      }

      const playerId = gameManager.addPlayerToRoom(roomCode, playerName, socket.id);
      socket.join(roomCode);

      callback({
        success: true,
        playerId,
        players: room.players,
      });

      io.to(roomCode).emit('playersUpdated', room.players);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: начало игры
  socket.on('startGame', (roomCode, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      if (!room) {
        return callback({ success: false, error: 'Комната не найдена' });
      }

      if (room.players.length < 4) {
        return callback({ success: false, error: 'Нужно минимум 4 игрока' });
      }

      gameManager.startGame(roomCode);
      
      // Отправляем каждому игроку его приватную роль
      room.players.forEach((player) => {
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
          // Для мафии показываем кто еще мафия
          let allies = [];
          if (player.role === 'mafia') {
            allies = room.players
              .filter((p) => p.role === 'mafia' && p.id !== player.id)
              .map((p) => ({ id: p.id, name: p.name }));
          }

          playerSocket.emit('roleAssigned', {
            role: player.role,
            description: gameManager.getRoleDescription(player.role),
            allies: allies, // Другие члены мафии видны только мафии
            // Специальное сообщение при 6 игроках (для более заметного уведомления)
            allyNotification: 
              allies.length > 0 
                ? `⚠️ ВАЖНО! Ваши союзники в мафии: ${allies.map((a) => a.name).join(', ')}. Не голосуйте за них в день!`
                : null,
          });
        }
      });

      // Начинаем первую ночь
      gameManager.startPhase(roomCode, 'night');
      io.to(roomCode).emit('gameStarted');
      io.to(roomCode).emit('phaseChanged', {
        phase: 'night',
        message: 'Наступила ночь... Мафия выбирает свою жертву.',
      });

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: игрок выполняет ночное действие
  socket.on('nightAction', (roomCode, targetPlayerId, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      const player = room?.players.find((p) => p.socketId === socket.id);

      if (!player || room.currentPhase !== 'night') {
        return callback({ success: false, error: 'Невозможно выполнить действие' });
      }

      gameManager.recordNightAction(roomCode, player.id, player.role, targetPlayerId);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });


  // Событие: отправка сообщения в чат
  socket.on('sendMessage', (roomCode, message, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      const player = room?.players.find((p) => p.socketId === socket.id);

      if (!player) {
        return callback({ success: false, error: 'Игрок не найден' });
      }

      // Нельзя писать в чат ночью
      if (room.currentPhase === 'night') {
        return callback({ success: false, error: 'Ночью нельзя писать в чат' });
      }

      // Проверяем, что игрок не мертв
      if (player.isDead) {
        return callback({ success: false, error: 'Мертвые не могут писать' });
      }

      const chatMessage = {
        playerId: player.id,
        playerName: player.name,
        message: message.slice(0, 300), // Ограничиваем длину
        timestamp: Date.now(),
      };

      io.to(roomCode).emit('newMessage', chatMessage);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: голосование за исключение
  socket.on('vote', (roomCode, targetPlayerId, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      const player = room?.players.find((p) => p.socketId === socket.id);
      const targetPlayer = room?.players.find((p) => p.id === targetPlayerId);

      if (!player || room.currentPhase !== 'voting') {
        return callback({ success: false, error: 'Голосование недоступно' });
      }

      if (player.isDead) {
        return callback({ success: false, error: 'Мертвые не могут голосовать' });
      }

      // Целевой игрок должен быть жив
      if (!targetPlayer || targetPlayer.isDead) {
        return callback({ success: false, error: 'Можно голосовать только за живых игроков' });
      }

      // Мафия не может голосовать за другую мафию
      if (player.role === 'mafia' && targetPlayer?.role === 'mafia') {
        return callback({ success: false, error: 'Мафия не может голосовать за другую мафию!' });
      }

      gameManager.recordVote(roomCode, player.id, targetPlayerId);
      callback({ success: true });

      // Проверяем, все ли проголосовали
      const allVoted = gameManager.isVotingComplete(roomCode);
      if (allVoted) {
        const eliminated = gameManager.processVoting(roomCode);
        io.to(roomCode).emit('votingEnded', { eliminatedPlayer: eliminated });

        // Проверяем условие победы
        const winner = gameManager.checkWinCondition(roomCode);
        if (winner) {
          // Отправляем полную информацию о конце игры
          const room = gameManager.getRoom(roomCode);
          io.to(roomCode).emit('gameEnded', { 
            winner,
            players: room.players, // Передаем всех игроков с ролями
          });
          gameManager.endGame(roomCode);
        } else {
          // Переход в ночь
          gameManager.startPhase(roomCode, 'night');
          io.to(roomCode).emit('phaseChanged', {
            phase: 'night',
            message: 'Наступила ночь... Мафия выбирает свою жертву.',
          });
        }
      }
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: получение состояния комнаты
  socket.on('getRoomState', (roomCode, callback) => {
    try {
      const room = gameManager.getRoom(roomCode);
      if (!room) {
        return callback({ success: false, error: 'Комната не найдена' });
      }

      callback({
        success: true,
        room: {
          code: room.code,
          players: room.players,
          gameState: room.gameState,
          currentPhase: room.currentPhase,
        },
      });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Событие: отключение игрока
  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
    gameManager.removePlayer(socket.id);
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Сервер Мафии запущен на http://localhost:${PORT}`);
  console.log(`Слушаем WebSocket подключения на порту ${PORT}`);
});
