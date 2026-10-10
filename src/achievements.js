'use strict';

// @AI-IMPROVEMENT (Etapa 1 - porta do SAM.Game/Manager.cs para Node.js):
// O SAM em C# faz: RequestUserStats(steamId) → para cada bit do schema:
// SetAchievement(name, bool) → StoreStats().
// Pela rede Steam (sem .exe, sem cliente aberto), o equivalente é:
//   1. EMsg.ClientGetUserStats (818)          → recebe stats + crc + achievement_blocks
//   2. editar os bits de achievement_blocks    → é assim que a rede representa
//      conquistas (conjunto de uint32, 1 bit = 1 conquista na ordem do schema)
//   3. EMsg.ClientStoreUserStats (820) com crc_stats atualizado
//   4. resposta 821 confirma (eresult 1 = OK); Failed_Validation = stat recusada
//
// O "schema" (nome → bit index) vem da Web API ISteamUserStats/GetSchemaForGame
// (lógica do SteamAchievementUnlockerALL), pois o binário UserGameStatsSchema
// do SAM só existe em instalações desktop do Steam.

const crypto = require('crypto');
const { EventEmitter } = require('events');

// EMsgs (mesmos valores confirmados no repo do SteamKit2/node-steam-user)
const EMSG_GET_USER_STATS = 818;
const EMSG_GET_USER_STATS_RESPONSE = 819;
const EMSG_STORE_USER_STATS = 820;
const EMSG_STORE_USER_STATS_RESPONSE = 821; // resposta do Store (ours via jobid)

const SCHEMA_CACHE_TTL = 10 * 60 * 1000; // 10 min

class AchievementsModule extends EventEmitter {
    // client: SteamUser já logado
    // apiKey: opcional (SteaWeb API) — sem ela, caímos no fallback de índice direto
    constructor(client, apiKey, log) {
        super();
        this.client = client;
        this.apiKey = apiKey || process.env.STEAM_API_KEY || '';
        this.log = log || ((msg, type) => console.log(`[${type || 'info'}] ${msg}`));
        this._schemaCache = new Map(); // appid -> { names: [apiName...], fetchedAt }
        this._pending = new Map(); // jobid string -> resolve callback
        this._installHandlers();
    }

    _installHandlers() {
        this.client._handlerManager.add(EMSG_GET_USER_STATS_RESPONSE, (body, header) => {
            this._onGetUserStatsResponse(body, header);
        });
        this.client._handlerManager.add(EMSG_STORE_USER_STATS_RESPONSE, (body, header) => {
            this._onStoreUserStatsResponse(body, header);
        });
    }

    // ------------------------------------------------------------------
    // STEP 1 - Buscar estado atual (UserStatsReceived do SAM)
    // ------------------------------------------------------------------
    _requestStats(appId, steamId64) {
        return new Promise((resolve, reject) => {
            const gameId = appId.toString(); // fixed64: GameID = appid p/ apps normais
            // crc inicial: 0 (o servidor devolve o real em crc_stats)
            this.client._send(
                { msg: EMSG_GET_USER_STATS },
                { game_id: gameId, crc_stats: 0, steam_id_for_user: steamId64 },
                (body, header, cb) => {
                    // este callback é chamado quando formos responder (não usamos resposta)
                }
            );
            // Na prática a resposta chega pelo handler acima; usamos timeout de segurança
            const t = setTimeout(() => reject(new Error('Timeout aguardando GetUserStatsResponse')), 15000);
            this._onStats = (body) => { clearTimeout(t); resolve(body); };
        });
    }

    _onGetUserStatsResponse(body, header) {
        if (this._onStats) {
            const f = this._onStats; this._onStats = null;
            f(body);
        }
    }

    // ------------------------------------------------------------------
    // Schema (UnlockerALL): nomes → índice de bit
    // ------------------------------------------------------------------
    async _getSchema(appId) {
        const cached = this._schemaCache.get(appId);
        if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL) return cached;

        if (!this.apiKey) {
            throw new Error('STEAM_API_KEY não configurada; necessário para mapear nomes de conquistas (GetSchemaForGame).');
        }

        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v0002/?key=${encodeURIComponent(this.apiKey)}&appid=${appId}&l=english&format=json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GetSchemaForGame falhou: HTTP ${res.status}`);
        const json = await res.json();
        const achievements = json.game && json.game.availableGameStats && json.game.availableGameStats.achievements;
        if (!achievements || achievements.length === 0) {
            throw new Error(`Nenhuma conquista encontrada para o AppID ${appId} (verifique se a API key tem dono do jogo).`);
        }
        // A ordem no schema é a ordem dos bits na rede.
        const schema = { fetchedAt: Date.now(), internalNames: achievements.map(a => a.name), displayNames: achievements.map(a => a.displayName) };
        this._schemaCache.set(appId, schema);
        return schema;
    }

    // ------------------------------------------------------------------
    // STEP 2+3 - Editar bits e guardar (SetAchievement + StoreStats do SAM)
    // ------------------------------------------------------------------
    async unlock(appId, achievementIds, mode = 'unlock') {
        if (!this.client.steamID) throw new Error('Não logado na Steam.');
        const steamId64 = this.client.steamID.getSteamID64();
        const statsBody = await this._requestStats(appId, steamId64);
        if (statsBody.eresult !== 1 && statsBody.eresult !== 2) {
            throw new Error(`GetUserStats resultou EResult ${statsBody.eresult}`);
        }

        // reconstrói o mapa stat_id → valor
        // achievement_blocks[0] contém os bits (fixed32) já desbloqueados
        let blocks = (statsBody.achievement_blocks || []);
        if (blocks.length === 0) {
            // O servidor podemandar o bloco aucontra (id 0) mesmo sem conquistas.
            blocks = [{ achievement_id: 0, unlock_time: [] }];
        }
        let block = blocks.find(b => b.achievement_id === 0) || blocks[0];

        // stat_value do bloco 0 é o uint32 com os bits;SAM usa" bits", a rede usa o stat_id do tipo "achievements".
        // fix: o valor dos bits vem como stats[] cujo stat_id == 0. assert.
        let bitsValue = 0;
        let statEntry = null;
        for (const s of (statsBody.stats || [])) {
            if (s.stat_id === 0) { statEntry = s; break; }
        }
        if (!statEntry) {
            statEntry = { stat_id: 0, stat_value: 0 };
        }
        bitsValue = statEntry.stat_value >>> 0;

        const schema = await this._getSchema(appId);
        const targetIds = Array.isArray(achievementIds) ? achievementIds : [achievementIds];

        for (const target of targetIds) {
            let index = schema.internalNames.indexOf(target);
            if (index === -1) index = schema.displayNames.indexOf(target);
            if (index === -1) {
                // bypass simples (UnlockerALL): aceita índice direto "bit:12"
                const m = /^bit:(\d+)$/.exec(String(target));
                if (m) {
                    index = parseInt(m[1], 10);
                    this.log(`Índice direto de bit ${index} forcado para "${target}"`, 'warning');
                } else {
                    throw new Error(`Conquista "${target}" não existe no schema do appid ${appId}`);
                }
            }
            if (index > 31) {
                // bloco extra além do primeiro uint32: usar achievement_id = floor(index/32)
                throw new Error(`Bit ${index} fora do primeiro bloco (32). Implementação atual limitada a 32 conquistas por bloco.`);
            }
            const mask = 1 << index;
            if (mode === 'unlock') bitsValue |= mask;
            else if (mode === 'clear') bitsValue &= ~mask >>> 0;
        }

        // Reenvia TUDO (stats existentes + bits alterados)
        const allStats = (statsBody.stats || []).filter(s => s.stat_id !== 0);
        allStats.push({ stat_id: 0, stat_value: bitsValue >>> 0 });

        // recalcula crc igual ao algoritmo da MMSistema (deve casar com o recebido)
        const crc = computeCrc(allStats);

        const storeBody = {
            game_id: appId.toString(),
            explicit_reset: false,
            stats_to_store: allStats,
            crc_stats: crc
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Timeout aguardando StoreUserStatsResponse')); }, 20000);
            const done = (ok, info) => { clearTimeout(timeout); cleanup(); resolve({ ok, ...info }); };
            this._pendingStore = done;
            function cleanup() { try { this._pendingStore = null; } catch (_) {} }
            this.client._send({ msg: EMSG_STORE_USER_STATS }, storeBody, (body, header, cb) => {});
        });
    }

    _onStoreUserStatsResponse(body, header) {
        const ok = body.eresult === 1;
        this.emit('stored', { ok, eresult: body.eresult, crc: body.crc_stats, failed: body.stats_failed_validation || [] });
        let d = null;
        try { d = this._pendingStore; } catch (_) {}
        if (d) d(ok, { eresult: body.eresult, failed: body.stats_failed_validation || [] });
    }
}

// CRC da rede (mesmo algoritmo usado pelo Steam client p/ CMsgClientGetUserStats.crc_stats)
function computeCrc(statEntries) {
    // O algoritmo oficial exige os itens ordenados por stat_id
    const sorted = [...statEntries].sort((a, b) => (a.stat_id >>> 0) - (b.stat_id >>> 0));
    const buf = Buffer.alloc(sorted.length * 8);
    let off = 0;
    for (const s of sorted) {
        buf.writeUInt32LE(s.stat_id >>> 0, off);
        buf.writeUInt32LE(s.stat_value >>> 0, off + 4);
        off += 8;
    }
    return crc32(buf) >>> 0;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (~crc) >>> 0;
}

module.exports = { AchievementsModule, computeCrc, crc32, EMSG_STORE_USER_STATS_RESPONSE };
