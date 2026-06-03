// Менеджер игр - управляет всеми комнатами и состояниями игры
export class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // Map<roomCode, RoomState>
    this.playerRoomMap = new Map(); // Map<socketId, roomCode>
  }

  // Создание новой комнаты
  createRoom(playerName, socketId) {
    const roomCode = this.generateRoomCode();
    const playerId = this.generatePlayerId();

    const room = {
      code: roomCode,
      creatorId: playerId,
      players: [
        {
          id: playerId,
          name: playerName,
          socketId,
          role: null,
          isDead: false,
          isConnected: true,
        },
      ],
      gameState: 'waiting', // 'waiting', 'playing', 'ended'
      currentPhase: null, // 'night', 'day', 'voting'
      nightSubPhase: null, // 'doctor', 'mafia', 'sheriff'
      nightActions: new Map(), // Map<playerId, targetId>
      votes: new Map(), // Map<playerId, targetId>
      nightResults: null,
      roles: [],
      completedNightActions: new Set(), // Кто уже выполнил действие в текущей подфазе
    };

    this.rooms.set(roomCode, room);
    this.playerRoomMap.set(socketId, roomCode);

    return { roomCode, playerId };
  }

  // Добавление игрока в комнату
  addPlayerToRoom(roomCode, playerName, socketId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');

    const playerId = this.generatePlayerId();
    room.players.push({
      id: playerId,
      name: playerName,
      socketId,
      role: null,
      isDead: false,
      isConnected: true,
    });

    this.playerRoomMap.set(socketId, roomCode);
    return playerId;
  }

  // Получение комнаты по коду
  getRoom(roomCode) {
    return this.rooms.get(roomCode);
  }

  // Начало игры - распределение ролей
  startGame(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');

    room.gameState = 'playing';
    const roles = this.distributeRoles(room.players.length);

    // Перемешиваем и назначаем роли
    for (let i = 0; i < room.players.length; i++) {
      room.players[i].role = roles[i];
    }

    room.roles = roles;
  }

  // Распределение ролей в зависимости от количества игроков
  distributeRoles(playerCount) {
    const roles = [];
    
    if (playerCount === 4 || playerCount === 5) {
      // 4-5 игроков: 1 мафия, 1 шериф, 1 доктор, остальные мирные
      roles.push('mafia');
      roles.push('sheriff', 'doctor');
      while (roles.length < playerCount) {
        roles.push('villager');
      }
    } else if (playerCount === 6) {
      // 6 игроков: 2 мафии, 1 шериф, 1 доктор, остальные мирные
      roles.push('mafia', 'mafia');
      roles.push('sheriff', 'doctor');
      while (roles.length < playerCount) {
        roles.push('villager');
      }
    } else if (playerCount >= 7) {
      // 7+ игроков: 3 мафии, 1 шериф, 1 доктор, остальные мирные
      roles.push('mafia', 'mafia', 'mafia');
      roles.push('sheriff', 'doctor');
      while (roles.length < playerCount) {
        roles.push('villager');
      }
    }

    // Перемешиваем роли
    return this.shuffleArray(roles);
  }

  // Перемешивание массива (Fisher-Yates)
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Описание роли
  getRoleDescription(role) {
    const descriptions = {
      mafia: 'Вы мафиози! Ночью вы выбираете жертву для устранения.',
      sheriff: 'Вы шериф! Ночью вы можете проверить одного игрока и узнать его роль.',
      doctor: 'Вы доктор! Ночью вы можете спасти одного игрока (включая себя) от убийства.',
      villager: 'Вы мирный житель! Днем помогите вычислить мафию.',
    };
    return descriptions[role] || 'Неизвестная роль';
  }

  // Начало фазы
  startPhase(roomCode, phase) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');

    room.currentPhase = phase;
    room.nightActions.clear();
    room.votes.clear();
    room.completedNightActions.clear();
    room.nightStartTime = Date.now(); // Сохраняем время начала ночи

    // Если ночь - начинаем с доктора
    if (phase === 'night') {
      room.nightSubPhase = 'doctor';
      this.io.to(roomCode).emit('nightSubPhaseChanged', {
        subPhase: 'doctor',
        message: '🌙 Ночь: Доктор выбирает кого спасать...',
      });
    }

    if (phase === 'day') {
      room.currentPhase = 'day';
      room.nightSubPhase = null;
      // После дня сразу голосование
      setTimeout(() => {
        room.currentPhase = 'voting';
        this.io.to(roomCode).emit('phaseChanged', {
          phase: 'voting',
          message: 'Время голосования! Выберите игрока для исключения.',
        });
      }, 30000); // 30 секунд для обсуждения
    }
  }

  // Переход на следующую подфазу ночи
  nextNightSubPhase(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room || room.currentPhase !== 'night') return;

    const subPhaseOrder = ['doctor', 'mafia', 'sheriff'];
    const currentIndex = subPhaseOrder.indexOf(room.nightSubPhase);
    
    if (currentIndex < subPhaseOrder.length - 1) {
      // Есть еще подфазы
      room.nightSubPhase = subPhaseOrder[currentIndex + 1];
      room.completedNightActions.clear();
      
      const messages = {
        doctor: '🌙 Ночь: Доктор выбирает кого спасать...',
        mafia: '🌙 Ночь: Мафия выбирает жертву...',
        sheriff: '🌙 Ночь: Шериф проверяет участника...',
      };

      this.io.to(roomCode).emit('nightSubPhaseChanged', {
        subPhase: room.nightSubPhase,
        message: messages[room.nightSubPhase],
      });
    } else {
      // Ночь закончилась, переходим на день
      this.processNightPhase(roomCode);
      const nightResults = this.getNightResults(roomCode);
      
      // Отправляем результаты проверок каждому шерифу приватно
      if (nightResults.sheriffChecks && nightResults.sheriffChecks.length > 0) {
        const room = this.rooms.get(roomCode);
        nightResults.sheriffChecks.forEach(({ playerId, role }) => {
          const sheriffPlayer = room.players.find((p) => p.id === playerId);
          if (sheriffPlayer) {
            const sheriffSocket = this.io.sockets.sockets.get(sheriffPlayer.socketId);
            if (sheriffSocket) {
              sheriffSocket.emit('sheriffCheckResult', {
                message: `🔍 Результат проверки: проверенный игрок является ${role === 'mafia' ? '🎭 МАФИЕЙ' : '👤 обычным игроком'}`,
              });
            }
          }
        });
      }
      
      const room = this.rooms.get(roomCode);
      this.io.to(roomCode).emit('nightEnded', {
        ...nightResults,
        players: room.players, // Отправляем обновленный список игроков
      });
      
      // Проверяем условие победы
      const winner = this.checkWinCondition(roomCode);
      if (winner) {
        this.io.to(roomCode).emit('gameEnded', { winner, players: room.players });
        this.endGame(roomCode);
      } else {
        // Переход в день
        this.startPhase(roomCode, 'day');
        this.io.to(roomCode).emit('phaseChanged', {
          phase: 'day',
          message: 'Наступил день! Начинается обсуждение.',
        });
      }
    }
  }

  // Запись ночного действия
  recordNightAction(roomCode, playerId, role, targetPlayerId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');

    // Проверяем что роль соответствует текущей подфазе
    const roleToSubPhase = {
      doctor: 'doctor',
      mafia: 'mafia',
      sheriff: 'sheriff',
    };

    if (roleToSubPhase[role] === room.nightSubPhase) {
      room.nightActions.set(playerId, targetPlayerId);
      room.completedNightActions.add(playerId);

      // Проверяем готовность подфазы
      const requiredPlayers = room.players.filter(
        (p) => !p.isDead && roleToSubPhase[p.role] === room.nightSubPhase
      );

      if (requiredPlayers.every((p) => room.completedNightActions.has(p.id))) {
        // Все участники подфазы выполнили действие - переходим к следующей
        this.nextNightSubPhase(roomCode);
      }
    }
  }

  // Обработка ночной фазы - применение ночных действий
  processNightPhase(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');

    const results = {
      killed: null,
      healed: null,
      checked: null,
    };

    // Получаем действия
    let targetToKill = null;
    const heals = new Map();
    const checks = new Map();

    // Обработка действий мафии (все мафиози голосуют за одну жертву)
    const mafiaActions = Array.from(room.nightActions.entries())
      .filter(([playerId]) => {
        const player = room.players.find((p) => p.id === playerId);
        return player && player.role === 'mafia';
      });

    if (mafiaActions.length > 0) {
      // Жертва - это самая часто выбираемая цель
      const targets = new Map();
      mafiaActions.forEach(([_, targetId]) => {
        targets.set(targetId, (targets.get(targetId) || 0) + 1);
      });
      targetToKill = Array.from(targets.entries())
        .sort((a, b) => b[1] - a[1])[0][0];
    }

    // Обработка действий доктора
    room.nightActions.forEach((targetId, playerId) => {
      const player = room.players.find((p) => p.id === playerId);
      if (player && player.role === 'doctor') {
        heals.set(targetId, true);
      }
    });

    // Обработка действий шерифа
    room.nightActions.forEach((targetId, playerId) => {
      const player = room.players.find((p) => p.id === playerId);
      if (player && player.role === 'sheriff') {
        const target = room.players.find((p) => p.id === targetId);
        if (target) {
          checks.set(playerId, target.role);
        }
      }
    });

    // Применяем убийство (если не спасли)
    if (targetToKill && !heals.has(targetToKill)) {
      const killedPlayer = room.players.find((p) => p.id === targetToKill);
      if (killedPlayer) {
        killedPlayer.isDead = true;
        results.killed = killedPlayer.name;
        results.killedRole = killedPlayer.role;
      }
    } else if (targetToKill && heals.has(targetToKill)) {
      results.healed = room.players.find((p) => p.id === targetToKill)?.name;
    }

    // Добавляем результаты проверок шерифа
    results.sheriffChecks = Array.from(checks.entries()).map(([playerId, role]) => ({
      playerId,
      role,
    }));

    room.nightResults = results;
  }

  // Получение результатов ночи
  getNightResults(roomCode) {
    const room = this.rooms.get(roomCode);
    return room?.nightResults || {};
  }

  // Запись голоса
  recordVote(roomCode, voterId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Комната не найдена');
    room.votes.set(voterId, targetId);
  }

  // Проверка, все ли проголосовали
  isVotingComplete(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    const aliveVoters = room.players.filter((p) => !p.isDead);
    return aliveVoters.every((p) => room.votes.has(p.id));
  }

  // Обработка голосования
  processVoting(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    // Считаем голоса
    const votes = new Map();
    room.votes.forEach((targetId) => {
      votes.set(targetId, (votes.get(targetId) || 0) + 1);
    });

    // Находим игрока с наибольшим количеством голосов
    const [eliminatedId] = Array.from(votes.entries())
      .sort((a, b) => b[1] - a[1])[0] || [null];

    if (eliminatedId) {
      const eliminated = room.players.find((p) => p.id === eliminatedId);
      if (eliminated) {
        eliminated.isDead = true;
        return eliminated;
      }
    }

    return null;
  }

  // Проверка условия победы
  checkWinCondition(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const aliveMafia = room.players.filter((p) => !p.isDead && p.role === 'mafia').length;
    const aliveVillagers = room.players.filter((p) => !p.isDead && p.role !== 'mafia').length;

    // Мафия побеждает, если равна количеству мирных
    if (aliveMafia >= aliveVillagers && aliveMafia > 0) {
      return 'mafia';
    }

    // Мирные побеждают, если вся мафия мертва
    if (aliveMafia === 0) {
      return 'villagers';
    }

    return null;
  }

  // Завершение игры
  endGame(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.gameState = 'ended';
  }

  // Удаление игрока (отключение)
  removePlayer(socketId) {
    const roomCode = this.playerRoomMap.get(socketId);
    if (!roomCode) return;

    const room = this.rooms.get(roomCode);
    if (!room) return;

    const playerIndex = room.players.findIndex((p) => p.socketId === socketId);
    if (playerIndex !== -1) {
      const player = room.players[playerIndex];
      player.isDead = true;
      player.isConnected = false;
    }

    // Если в комнате никого, удаляем комнату
    const connectedPlayers = room.players.filter((p) => p.isConnected);
    if (connectedPlayers.length === 0) {
      this.rooms.delete(roomCode);
    }

    this.playerRoomMap.delete(socketId);
  }

  // Вспомогательные методы

  generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  generatePlayerId() {
    return `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
