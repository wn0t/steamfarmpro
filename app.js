'use strict';

/*
 * Steam Multi-Farm PRO v3.0 — Motor
 * Etapa 1: gerenciamento de sessão (HourBoostr), farm de cartas (real),
 *          desbloqueio de conquistas via rede (SAM protobuf), vault AES-256-GCM.
 * Etapa 2: login tradicional (senha + Steam Guard manual ou TOTP), QR Code, cookie web.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const path = require('path');

const { AuthManager } = require('./src/auth');
const { AchievementsModule, EMSG_STORE_USER_STATS_RESPONSE } = require('./src/achievements');
const { BotSession } = require('./src/bot-session');
const { CardFarm } = require('./src/card-farm');
const vault = require('./src/credentials-vault');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------
function logToUI(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${message}`;
    console.log(logMsg);
    io.emit('log', { message: logMsg, type });
}

// ---------------------------------------------------------------------
// Motor — uma sessão Steam ativa
// ---------------------------------------------------------------------
let client = null;      // SteamUser
let community = null;   // SteamCommunity
let bot = null;         // BotSession (HourBoostr port)
let cards = null;       // CardFarm
let achievements = null;// AchievementsModule
let authManager = null; // AuthManager

const state = {
    isFarming: false,
    isPaused: false,
    mode: 'hours',
    gamesToPlay: [],
    reconnectAttempts: 0,
    maxReconnects: 5,
    pendingGuardLogin: null, // sessão steam-session aguardando código
    lastSessionInfo: null,
    loggedIn: false // conta autenticada (farm ainda não precisa estar rodando)
};

const savedCreds = vault.load(); // { username, password?, refreshToken?, sharedSecret?, games?, mode?, personaState? }

function newMotor(start = false) {
    client = new SteamUser({
        autoPumpCPU: false,
        enablePicsCache: true
    });
    state.autoStartFarm = start; // se true, o farm já dispara ao logar
    community = new SteamCommunity();
    bot = new BotSession(client, community, logToUI);
    cards = new CardFarm({ client, community, log: logToUI });
    achievements = new AchievementsModule(client, process.env.STEAM_API_KEY, logToUI);
    authManager = new AuthManager(logToUI, onSessionReady);

    bot.wirePlayingBlocked();
    bot.wireWebSessionRefresh();
    wireClientEvents();
    return client;
}

function wireClientEvents() {
    client.on('loggedOn', () => {
        logToUI('✅ Conectado à rede Steam com sucesso!', 'success');
        state.reconnectAttempts = 0;
        state.loggedIn = true;

        const persona = EPersonaStateFromString(state.personaState || 'online');
        client.setPersona(persona);

        // O farm SÓ inicia se o usuário apertar "Iniciar" (ou autoStart no auto-login)
        if (!state.autoStartFarm) {
            logToUI('Sessão ativa. Vá ao Painel e pressione 🚀 Iniciar Motor quando quiser farmar.', 'info');
            publishState();
            return;
        }
        state.autoStartFarm = false;
        if (state.mode === 'hours' && state.gamesToPlay.length) {
            bot.setGames(state.gamesToPlay);
            logToUI(`🚀 Farm de Horas iniciado — AppIDs: ${state.gamesToPlay.filter(x => typeof x === 'number').join(', ')}`, 'success');
        }
        publishState();
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        logToUI('Sessão Web (cookies) obtida. Pronto para interações da Comunidade.', 'success');
        if (state.mode === 'cards' && state.isFarming) {
            cards.start(state.gamesToPlay.filter(x => typeof x === 'number')).catch(e => logToUI('Farm de cartas erro: ' + e.message, 'error'));
        }
    });

    client.on('error', (err) => {
        logToUI(`❌ Erro crítico na Steam: ${err.message}`, 'error');
        if (err.message.includes('RateLimitExceeded')) {
            logToUI('Limite de requisições atingido. Dormindo 15 minutos (anti-lock HourBoostr).', 'warning');
            setTimeout(reconnect, 15 * 60 * 1000);
        } else if (err.message.includes('InvalidPassword')) {
            logToUI('Credencial rejeitada. Interrompendo reconexão.', 'error');
            state.isFarming = false;
        }
        publishState();
    });

    client.on('disconnected', (eresult, msg) => {
        logToUI(`🔌 Desconectado da Steam. Motivo: ${msg || eresult}`, 'warning');
        // A conta continua "logada" (token salvo) — reconecta se estava farmando
        if (!state.isFarming) {
            state.loggedIn = false;
            publishState();
            return;
        }

        state.reconnectAttempts++;
        if (state.reconnectAttempts > state.maxReconnects) {
            logToUI('Máximo de tentativas atingido. Farm interrompido.', 'error');
            state.isFarming = false;
            publishState();
            return;
        }
        bot.handleDisconnectLoop({ attempt: state.reconnectAttempts, max: state.maxReconnects }).then(reset => {
            if (reset) state.reconnectAttempts = 0;
            const delay = Math.min(state.reconnectAttempts * 5000, 60000); // backoff progressivo
            logToUI(`Reconectando em ${delay / 1000}s (tentativa ${state.reconnectAttempts}/${state.maxReconnects}).`, 'warning');
            setTimeout(reconnect, delay);
        });
    });

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
        // Fallback nativo: quando nem TOTP nem código manual foram fornecidos no POST,
        // avisamos no painel para o usuário enviar via /api/steamguard-code.
        logToUI(`🔐 Steam Guard necessário${domain ? ` (enviado para ${domain})` : ' (app móvel)'}. Envie o código no painel.`, 'warning');
        state.pendingGuardLogin = callback; // guardamos o callback do steam-user p/ entrega futura
        if (lastCodeWrong) logToUI('⚠ Último código estava errado, digite novamente.', 'error');
        publishState();
    });

    client.on('refreshToken', (t) => {
        // persiste refresh token criptografado para boots futuros sem senha
        if (t) {
            vault.save({ ...savedCreds, refreshToken: t, username: savedCreds.username });
        }
    });
}

function reconnect() {
    if (!state.isFarming) return;
    if (state.lastSessionInfo && state.lastSessionInfo.refreshToken) {
        client.logOn({ refreshToken: state.lastSessionInfo.refreshToken });
    } else if (savedCreds.username && savedCreds.refreshToken) {
        client.logOn({ accountName: savedCreds.username, refreshToken: savedCreds.refreshToken });
    } else if (savedCreds.username && savedCreds.password) {
        client.logOn({ accountName: savedCreds.username, password: savedCreds.password, twoFactorCode: savedCreds.sharedSecret ? require('steam-totp').generateAuthCode(savedCreds.sharedSecret) : undefined });
    } else {
        logToUI('Sem credenciais salvas para reconectar. Faça login novamente.', 'error');
        state.isFarming = false;
    }
}

function onSessionReady(info) {
    // info = { refreshToken, steamId64, accountName?, method }
    state.lastSessionInfo = info;
    // PERSISTÊNCIA: guarda refreshToken/username criptografados para auto-login
    vault.save({
        ...savedCreds,
        method: info.method,
        username: info.accountName || savedCreds.username,
        steamId64: info.steamId64,
        refreshToken: info.refreshToken || savedCreds.refreshToken
    });
    Object.assign(savedCreds, vault.load());

    if (info.mode === 'web') {
        // Modo Web: sem CM (client) — limitado a farm de cartas via comunidade web
        state.loggedIn = true;
        state.mode = state.mode || 'cards';
        logToUI('🌐 Modo WEB ativado — vá ao Painel e pressione 🚀 Iniciar Motor.', 'warning');
        publishState();
        return;
    }

    // steam-user v5 aceita logOn({ refreshToken }) — logar NÃO liga o farm
    client.logOn({ refreshToken: info.refreshToken });
    logToUI(`Sessão Steam (${info.method}) autenticada. Vá ao Painel para iniciar o farm.`, 'success');
    publishState();
}

function EPersonaStateFromString(s) {
    const map = {
        online: SteamUser.EPersonaState.Online,
        invisible: SteamUser.EPersonaState.Invisible,
        offline: SteamUser.EPersonaState.Offline
    };
    return map[s] || SteamUser.EPersonaState.Online;
}

// ---------------------------------------------------------------------
// Helpers parsing de campos do /start
// ---------------------------------------------------------------------
function parseGamesField(rawGames, customTitle) {
    const list = [];
    if (customTitle && customTitle.trim() !== '') {
        list.push(customTitle.trim()); // steam-user manda string => game_extra_info
    }
    if (rawGames) {
        const ids = rawGames.split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
        const maxIds = customTitle ? 31 : 32;
        list.push(...ids.slice(0, maxIds));
    }
    return list;
}

function publishState() {
    io.emit('state', {
        isFarming: state.isFarming,
        isPaused: state.isPaused,
        mode: state.mode,
        loggedIn: state.loggedIn,
        hasSavedLogin: !!(savedCreds && savedCreds.refreshToken),
        awaitingGuard: !!state.pendingGuardLogin,
        steamId: client && client.steamID ? client.steamID.getSteamID64() : null,
        games: state.gamesToPlay || []
    });
}

// =====================================================================
// API REST
// =====================================================================

// --- ETAPA 2 - MÉTODO 1: Login tradicional (senha + guard opcional) ---
app.post('/api/login/password', async (req, res) => {
    const { username, password, sharedSecret, guardCode, remember, status, mode, games, customTitle } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Informar usuário e senha.' });

    if (!client) newMotor();
    if (!client) return res.status(500).json({ error: 'Motor não inicializado.' });
    if (client.steamID) client.logOff(); // garante sessão limpa antes de novo logon
    state.gamesToPlay = parseGamesField(games, customTitle);
    state.mode = mode || 'hours';
    state.personaState = status || 'online';
    // FARM SÓ INICIA COM O BOTÃO 🚀 do painel — login apenas autentica
    state.isFarming = false;
    state.isPaused = false;

    try {
        // Persistimos preferências de farm MESMO que o farm só ligue por botão depois
        const savedPrefs = { mode: state.mode, games: state.gamesToPlay, personaState: state.personaState };
        if (guardCode || sharedSecret) {
            await authManager.loginWithPassword({ username, password, sharedSecret, guardCode });
            // onSessionReady → client.logOn({refreshToken}) → salva refreshToken
            if (remember) vault.save({ ...savedCreds, username, sharedSecret: sharedSecret || savedCreds.sharedSecret, ...savedPrefs });
            Object.assign(savedCreds, vault.load());
        } else {
            // Sem 2FA: steam-user lida nativamente via evento 'steamGuard'
            state.lastSessionInfo = { method: 'password-native', username };
            client.logOn({ accountName: username, password });
            // PERSISTÊNCIA: salvar credenciais para auto-login no próximo boot
            if (remember) vault.save({ ...savedCreds, username, password, sharedSecret: '', ...savedPrefs });
            Object.assign(savedCreds, vault.load());
        }
        publishState();
        res.json({ success: true, detail: 'login initiated' });
    } catch (e) {
        if (String(e.message).includes('GUARD_CODE_REQUIRED')) {
            state.pendingGuardLogin = e.session || null;
            publishState();
            return res.json({ success: false, needsGuardCode: true });
        }
        logToUI('Falha no login (método senha): ' + e.message, 'error');
        res.status(400).json({ error: e.message });
    }
});

// Envio de código Steam Guard (manual) para login pendente
app.post('/api/steamguard-code', async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Informe o código.' });
    if (state.pendingGuardLogin) {
        try {
            state.pendingGuardLogin(code); // callback do evento steamGuard do steam-user
            state.pendingGuardLogin = null;
            publishState();
            return res.json({ success: true });
        } catch (e) {
            return res.status(400).json({ error: 'Código rejeitado: ' + e.message });
        }
    }
    if (authManager && authManager._pendingSession) {
        try { await authManager.submitGuardCode(code); return res.json({ success: true }); }
        catch (e) { return res.status(400).json({ error: e.message }); }
    }
    res.status(400).json({ error: 'Nenhum login pendente de código.' });
});

// --- ETAPA 2 - MÉTODO 2: Login via QR Code ---
app.post('/api/login/qr', async (req, res) => {
    try {
        if (!client) newMotor();
        if (client.steamID) client.logOff(); // garante sessão limpa antes de novo logon
        const { mode, games, customTitle, status } = req.body || {};
        if (games || customTitle) state.gamesToPlay = parseGamesField(games, customTitle);
        if (mode) state.mode = mode;
        if (status) state.personaState = status;
        // QR só autentica — farm continua off até o botão 🚀 do painel
        state.isFarming = false;
        state.isPaused = false;
        vault.save({ ...savedCreds, mode: state.mode, games: state.gamesToPlay, personaState: state.personaState });
        Object.assign(savedCreds, vault.load());

        const { qrDataUrl, challengeUrl } = await authManager.beginQrLogin();
        publishState();
        res.json({ success: true, qrDataUrl, challengeUrl });
    } catch (e) {
        logToUI('Falha ao gerar QR: ' + e.message, 'error');
        res.status(500).json({ error: e.message });
    }
});

// --- ETAPA 2 - MÉTODO 3: Login via cookie web (steamLoginSecure) ---
app.post('/api/login/web', async (req, res) => {
    const { steamLoginSecure, mode, games, customTitle } = req.body || {};
    if (!steamLoginSecure) return res.status(400).json({ error: 'Informe a linha steamLoginSecure=...' });
    try {
        if (!client) newMotor();
        if (games || customTitle) state.gamesToPlay = parseGamesField(games, customTitle);
        if (mode) state.mode = mode;
        state.isFarming = false; // farm só liga por botão depois
        await authManager.loginWithWebCookie(steamLoginSecure);
        res.json({ success: true, ...state.lastSessionInfo });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ------------------------------------------------------------
// AUTO-LOGIN: usa refreshToken criptografado salvo no vault.
// Chamado pelo frontend no boot (GET /api/state → hasSavedLogin).
// NÃO liga o farm — apenas recupera a sessão Steam.
// ------------------------------------------------------------
app.post('/api/autologin', async (req, res) => {
    if (!savedCreds || !savedCreds.refreshToken) {
        return res.status(400).json({ error: 'Nenhum login salvo neste dispositivo.' });
    }
    if (!client) newMotor();
    if (state.loggedIn && client && client.steamID) {
        return res.json({ success: true, alreadyLogged: true });
    }
    if (client.steamID) client.logOff();
    logToUI(`🔄 Auto-login com sessão salva${savedCreds.username ? ` (${savedCreds.username})` : ''}...`, 'info');
    // restaura preferências salvas no painel
    if (savedCreds.mode) state.mode = savedCreds.mode;
    if (Array.isArray(savedCreds.games)) state.gamesToPlay = savedCreds.games;
    if (savedCreds.personaState) state.personaState = savedCreds.personaState;
    state.isFarming = false; // farm continua desligado até o botão
    try {
        client.logOn({ refreshToken: savedCreds.refreshToken });
        publishState();
        res.json({ success: true });
    } catch (e) {
        logToUI('Auto-login falhou: ' + e.message, 'error');
        res.status(401).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------
// Controles do motor
// ---------------------------------------------------------------------
app.post('/api/start', (req, res) => {
    // Painel: iniciar farm NÃO é login — exige conta autenticada
    const { mode, games, customTitle } = req.body || {};
    if (mode) state.mode = mode;
    if (games || customTitle) state.gamesToPlay = parseGamesField(games, customTitle);

    if (!state.loggedIn || !client || !client.steamID) {
        return res.status(400).json({ error: 'Faça login na aba Sessão primeiro.' });
    }
    // restaura preferências salvas no login
    vault.save({ ...savedCreds, mode: state.mode, games: state.gamesToPlay, personaState: state.personaState });
    Object.assign(savedCreds, vault.load());

    state.isFarming = true;
    state.isPaused = false;
    if (state.mode === 'hours') {
        bot.setGames(state.gamesToPlay);
    } else if (state.mode === 'cards') {
        cards.start(state.gamesToPlay.filter(x => typeof x === 'number')).catch(e => logToUI('Farm de cartas erro: ' + e.message, 'error'));
    }
    publishState();
    res.json({ success: true });
});

app.post('/api/pause', (req, res) => {
    if (!state.isFarming || state.isPaused) return res.status(400).json({ error: 'Nada a pausar.' });
    state.isPaused = true;
    bot.stopGames();
    if (cards) cards.stop();
    logToUI('⏸ Farm pausado (tempo de jogo não contabilizado).', 'warning');
    publishState();
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    if (cards) cards.stop();
    if (bot) bot.destroy();
    if (client) { try { client.logOff(); } catch (_) {} }
    state.isFarming = false;
    state.isPaused = false;
    state.pendingGuardLogin = null;
    // NÃO apaga credenciais salvas — o usuário continua logado no próximo boot;
    // "Desligar" aqui significa "parar o farm", não "deslogar da conta".
    state.loggedIn = false;
    logToUI('⏹ Farm desligado. Sessão da conta permanece salva (auto-login no próximo boot).', 'info');
    publishState();
    res.json({ success: true });
});

// Logout: apaga credenciais do vault e desloga (botão separado na UI)
app.post('/api/logout', (req, res) => {
    if (cards) cards.stop();
    if (bot) bot.destroy();
    if (client) { try { client.logOff(); } catch (_) {} }
    state.isFarming = false;
    state.isPaused = false;
    state.loggedIn = false;
    vault.save({}); // apaga credenciais de fato
    Object.assign(savedCreds, {});
    logToUI('🚪 Sessão encerrada e credenciais apagadas do dispositivo.', 'warning');
    publishState();
    res.json({ success: true });
});

// Foto/nome do perfil (usado pela notificação do APK e pela UI)
app.get('/api/profile', async (req, res) => {
    if (!community || !community.steamID) {
        return res.status(400).json({ error: 'Sem sessão web ativa.' });
    }
    try {
        const user = await new Promise((resolve, reject) => {
            community.getSteamUser(community.steamID, (err, u) => err ? reject(err) : resolve(u));
        });
        res.json({
            steamId64: community.steamID.getSteamID64(),
            name: user.name,
            avatarUrl: user.avatarHash ? `https://avatars.akamai.steamstatic.com/${user.avatarHash}_full.jpg` : null,
            isFarming: state.isFarming,
            games: state.gamesToPlay || []
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------
// Conquistas (SAM por rede) + bulk
// ---------------------------------------------------------------------
app.post('/api/achievements', async (req, res) => {
    const { appId, achievementId, mode = 'unlock' } = req.body || {};
    if (!state.isFarming || !client || !client.steamID) {
        return res.status(400).json({ error: 'Conecte-se primeiro (motor precisa estar ativo).' });
    }
    if (!appId || !achievementId) return res.status(400).json({ error: 'Informe appId e achievementId.' });
    logToUI(`🏆 Desbloqueando "${achievementId}" no jogo ${appId} (SAM via rede)...`, 'info');
    try {
        const out = await achievements.unlock(appId, [achievementId], mode);
        if (out.ok) {
            logToUI(`✅ Conquista "${achievementId}" STORADA com sucesso (sem .exe!).`, 'success');
            res.json({ success: true, ...out });
        } else {
            logToUI(`Falha ao guardar (EResult ${out.eresult}).`, 'error');
            res.status(400).json({ error: `EResult ${out.eresult}`, ...out });
        }
    } catch (e) {
        logToUI('Erro no desbloqueio: ' + e.message, 'error');
        res.status(500).json({ error: e.message });
    }
});

// Bulk: desbloqueia TODAS as conquistas do jogo (UnlockerALL)
app.post('/api/achievements/bulk', async (req, res) => {
    const { appId, mode = 'unlock' } = req.body || {};
    if (!state.isFarming || !client || !client.steamID) {
        return res.status(400).json({ error: 'Conecte-se primeiro.' });
    }
    try {
        const schema = await achievements._getSchema(appId);
        logToUI(`🔥 Bulk unlock: ${schema.internalNames.length} conquista(s) de ${appId}.`, 'warning');
        const out = await achievements.unlock(appId, schema.internalNames, mode);
        if (out.ok) {
            logToUI(`✅ ${schema.internalNames.length} conquista(s) processadas em massa!`, 'success');
        }
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Lista de conquistas de um AppID (schema) — auxiliar de UI
app.get('/api/achievements/schema/:appId', async (req, res) => {
    try {
        const s = await achievements._getSchema(req.params.appId);
        res.json({ appid: req.params.appId, count: s.internalNames.length, achievements: s.internalNames.map((n, i) => ({ index: i, apiName: n, displayName: s.displayNames[i] })) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Estado geral (polling opcional)
app.get('/api/state', (req, res) => {
    res.json({
        isFarming: state.isFarming,
        isPaused: state.isPaused,
        mode: state.mode,
        loggedIn: state.loggedIn,
        hasSavedLogin: !!(savedCreds && savedCreds.refreshToken),
        awaitingGuard: !!state.pendingGuardLogin,
        steamId: client && client.steamID ? client.steamID.getSteamID64() : null,
        games: state.gamesToPlay || []
    });
});

// ---------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------
process.on('SIGINT', () => {
    logToUI('Desligando servidor com segurança...', 'warning');
    if (cards) cards.stop();
    if (bot) bot.destroy();
    if (client) { try { client.logOff(); } catch (_) {} }
    setTimeout(() => process.exit(0), 1000);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => logToUI(`🚀 Steam Multi-Farm PRO v3 rodando em http://localhost:${PORT}`, 'success'));
