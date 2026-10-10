'use strict';

// Etapa 1 - Farm de Cartas (removendo o STUB). Lógica:
//  1. GET https://steamcommunity.com/my/badges/ + cheerio → progresso por jogo
//  2. Fila: jogos com drop restante; < 2h de jogo primeiro (agiliza drops)
//  3. Rotate: a cada 30 min (ou quando detecta novo item) → gamesPlayed([appId])

const Cheerio = require('cheerio');
const { EventEmitter } = require('events');

const ROTATE_MINUTES = 30;

class CardFarm extends EventEmitter {
    // client: SteamUser; community: SteamCommunity (com cookies já setados)
    constructor({ client, community, log }) {
        super();
        this.client = client;
        this.community = community;
        this.log = log || ((msg, type) => console.log(`[${type || 'info'}] ${msg}`));
        this.queue = []; // [{appId, remainingDrops, hoursPlayed}]
        this.rotateTimer = null;
        this.running = false;
        this.currentIndex = -1;
    }

    async start(candidateAppIds) {
        this.running = true;
        this.log('Farm de Cartas iniciado. Varrendo insígnias (página de badges)...', 'info');
        try {
            this.queue = await this._scanBadges(candidateAppIds);
            this.log(`Fila de farm: ${this.queue.length} jogo(s) com drops restantes.`, 'success');
        } catch (e) {
            this.log(`Falha ao varrer badges: ${e.message}. Usando lista do usuário como fila fallback.`, 'warning');
            this.queue = (candidateAppIds || []).map(id => ({ appId: id, remainingDrops: 1, hoursKnown: false }));
        }
        this._playNext();
        this._scheduleRotate();
        this.emit('started', this.queue);
    }

    // ------------------------------------------------------------------
    // Scrape da página de insígnias (equivalente a point 2/3 do TODO do SAM)
    // ------------------------------------------------------------------
    async _scanBadges(candidateAppIds) {
        if (!this.community || !this.community.steamID) {
            throw new Error('steamcommunity sem sessão web (login necessário).');
        }
        const profileUrl = this.community.steamID.toString(); // profiles/steamid64
        const url = `https://steamcommunity.com/${profileUrl}/badges`;
        const result = await new Promise((resolve, reject) => {
            this.community.httpRequestGet({ uri: url }, (err, res, body) => {
                if (err) return reject(err);
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                resolve(body);
            });
        });

        const $ = Cheerio.load(result);
        const candidates = new Set((candidateAppIds || []).map(Number));
        const found = [];

        $('.badge_row').each((i, el) => {
            const href = $(el).find('.badge_row_playgame_url').attr('href') || '';
            const m = /(?:app|storeclock)\/(\d+)/.exec(href);
            if (!m) return;
            const appId = parseInt(m[1], 10);
            if (candidateAppIds && candidateAppIds.length && !candidates.has(appId)) return;

            const progressTxt = $(el).find('.badge_progress_info').text().trim(); // "3 / 5"
            const statsBlock = $(el).find('.badge_progress_tasks');
            const diffMatch = statsBlock.text().match(/([\d\.]+) hrs/);
            const hours = diffMatch ? parseFloat(diffMatch[1]) : null;
            let dropsLeft = null;
            if (progressTxt) {
                const p = progressTxt.split('/').map(x => parseInt(x.trim(), 10));
                if (p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
                    dropsLeft = p[1] - p[0];
                }
            }
            if (dropsLeft === null || dropsLeft > 0) {
                found.push({ appId, remainingDrops: dropsLeft === null ? 1 : dropsLeft, hoursPlayed: hours });
            }
        });

        // Prioridade: jogos com < 2h primeiro (drops mais rápidos), e depois por mais drops restantes
        found.sort((a, b) => {
            const aSub2 = a.hoursPlayed !== null && a.hoursPlayed < 2 ? 1 : 0;
            const bSub2 = b.hoursPlayed !== null && b.hoursPlayed < 2 ? 1 : 0;
            if (aSub2 !== bSub2) return bSub2 - aSub2;
            return (b.remainingDrops || 0) - (a.remainingDrops || 0);
        });
        return found;
    }

    _playNext() {
        if (!this.running || this.queue.length === 0) {
            if (this.running) this.log('Fila de cartas vazia — todos os jogos escaneados já esgotaram os drops.', 'success');
            return;
        }
        this.currentIndex = (this.currentIndex + 1) % this.queue.length;
        const game = this.queue[this.currentIndex];
        this.client.gamesPlayed([game.appId]);
        this.log(`▶ Farm de cartas: jogoando AppID ${game.appId} (restam ~${game.remainingDrops} drops).`, 'info');
        this.emit('nowPlaying', game);
    }

    _scheduleRotate() {
        if (this.rotateTimer) clearInterval(this.rotateTimer);
        this.rotateTimer = setInterval(() => {
            if (!this.running) return;
            this.log('↻ Rotacionando para o próximo jogo da fila (30 min expirados).', 'info');
            this._playNext();
        }, ROTATE_MINUTES * 60 * 1000);
        this.rotateTimer.unref && this.rotateTimer.unref();
    }

    stop() {
        this.running = false;
        if (this.rotateTimer) { clearInterval(this.rotateTimer); this.rotateTimer = null; }
        this.emit('stopped');
    }
}

module.exports = { CardFarm, ROTATE_MINUTES };
