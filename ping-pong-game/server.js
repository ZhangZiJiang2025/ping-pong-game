const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
  players: [],
  waitingPlayers: [],
  ball: null,
  scores: [0, 0],
  gameStarted: false,
  playersReady: [false, false],
  difficulty: 'medium'
};

const DIFFICULTY_SPEEDS = {
  easy: 3,
  medium: 5,
  hard: 7
};

function broadcast(data) {
  gameState.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(data));
    }
  });
}

function resetBall() {
  const speed = DIFFICULTY_SPEEDS[gameState.difficulty];
  return {
    x: 400,
    y: 300,
    vx: (Math.random() > 0.5 ? 1 : -1) * speed,
    vy: (Math.random() - 0.5) * speed * 0.6
  };
}

function resetGame(keepScores = false) {
  gameState.ball = resetBall();
  gameState.gameStarted = false;
  gameState.playersReady = [false, false];
  if (!keepScores) {
    gameState.scores = [0, 0];
  }
  gameState.players.forEach((player, idx) => {
    player.y = 250;
  });
}

function updateGame() {
  if (!gameState.gameStarted || gameState.players.length !== 2) return;

  const ball = gameState.ball;
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Wall collision
  if (ball.y <= 10 || ball.y >= 590) {
    ball.vy *= -1;
  }

  // Paddle collision
  gameState.players.forEach((player, idx) => {
    const paddleX = idx === 0 ? 20 : 760;
    const paddleWidth = 20;
    const paddleHeight = 100;

    if (
      ball.x - 10 < paddleX + paddleWidth &&
      ball.x + 10 > paddleX &&
      ball.y > player.y &&
      ball.y < player.y + paddleHeight
    ) {
      ball.vx *= -1;
      const hitPos = (ball.y - player.y - paddleHeight / 2) / (paddleHeight / 2);
      ball.vy += hitPos * 2;
    }
  });

  // Score
  if (ball.x < 0) {
    gameState.scores[1]++;
    broadcast({ type: 'score', scores: gameState.scores });

    if (gameState.scores[1] >= 5) {
      broadcast({ type: 'gameOver', winner: 1 });
      gameState.gameStarted = false;
      return;
    }

    gameState.ball = resetBall();
  } else if (ball.x > 800) {
    gameState.scores[0]++;
    broadcast({ type: 'score', scores: gameState.scores });

    if (gameState.scores[0] >= 5) {
      broadcast({ type: 'gameOver', winner: 0 });
      gameState.gameStarted = false;
      return;
    }

    gameState.ball = resetBall();
  }

  broadcast({
    type: 'update',
    ball: gameState.ball,
    players: gameState.players.map(p => ({ y: p.y }))
  });
}

setInterval(updateGame, 1000 / 60);

wss.on('connection', (ws) => {
  if (gameState.players.length < 2) {
    const playerIndex = gameState.players.length;
    const player = { ws, y: 250, index: playerIndex };
    gameState.players.push(player);

    ws.send(JSON.stringify({
      type: 'init',
      playerIndex: playerIndex,
      difficulty: gameState.difficulty
    }));

    broadcast({
      type: 'playerCount',
      count: gameState.players.length
    });

    if (gameState.players.length === 2 && !gameState.ball) {
      resetGame();
      broadcast({
        type: 'bothReady',
        scores: gameState.scores
      });
    }
  } else {
    gameState.waitingPlayers.push(ws);
    ws.send(JSON.stringify({
      type: 'waiting',
      message: '対戦中です。しばらくお待ちください'
    }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const playerIndex = gameState.players.findIndex(p => p.ws === ws);

      if (playerIndex === -1) return;

      if (data.type === 'move') {
        const player = gameState.players[playerIndex];
        player.y = Math.max(0, Math.min(500, data.y));
      } else if (data.type === 'ready') {
        gameState.playersReady[playerIndex] = true;

        if (gameState.playersReady.every(ready => ready)) {
          gameState.gameStarted = true;
          broadcast({ type: 'start' });
        }
      } else if (data.type === 'restart') {
        gameState.playersReady[playerIndex] = true;

        if (gameState.playersReady.every(ready => ready)) {
          resetGame();
          gameState.gameStarted = true;
          broadcast({ type: 'start' });
        }
      } else if (data.type === 'difficulty') {
        if (playerIndex === 0 && !gameState.gameStarted) {
          gameState.difficulty = data.difficulty;
          broadcast({ type: 'difficulty', difficulty: data.difficulty });
        }
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    const playerIndex = gameState.players.findIndex(p => p.ws === ws);

    if (playerIndex !== -1) {
      gameState.players.splice(playerIndex, 1);

      const remaining = gameState.players[0];
      if (remaining) {
        remaining.ws.send(JSON.stringify({
          type: 'opponentLeft',
          message: '相手が切断しました。新しい相手を待っています...'
        }));
        remaining.index = 0;
        remaining.ws.send(JSON.stringify({
          type: 'init',
          playerIndex: 0,
          difficulty: gameState.difficulty
        }));
      }

      resetGame();

      if (gameState.waitingPlayers.length > 0) {
        const nextPlayer = gameState.waitingPlayers.shift();
        if (nextPlayer.readyState === WebSocket.OPEN) {
          const newPlayerIndex = gameState.players.length;
          const player = { ws: nextPlayer, y: 250, index: newPlayerIndex };
          gameState.players.push(player);

          nextPlayer.send(JSON.stringify({
            type: 'init',
            playerIndex: newPlayerIndex,
            difficulty: gameState.difficulty
          }));

          if (gameState.players.length === 2) {
            broadcast({
              type: 'bothReady',
              scores: gameState.scores
            });
          }
        }
      }

      broadcast({
        type: 'playerCount',
        count: gameState.players.length
      });
    } else {
      const waitingIndex = gameState.waitingPlayers.indexOf(ws);
      if (waitingIndex !== -1) {
        gameState.waitingPlayers.splice(waitingIndex, 1);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
