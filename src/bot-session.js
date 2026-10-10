'use strict';

// Porta para Node.js da mecânica do HourBoostr (C#):
//  - SetGamesPlaying(bool) → ClientGamesPlayed (equivalente ao gamesPlayed do steam-user)
//  - RestartGames a cada ~3h + 20..60s de jitter (Bot.cs::LogOnSuccess)
//  - PlayingBlocked → CallbackStops quando o usuário está usando a conta (ExtraHandler)
//  - Web session refresh a cada 15 min (VerifyCommunityConnection)
//  - 15 min de sleep após 5 desconexões seguidas (rate limit / lock de jogo)

const { EventEmitter } = require('events');

class BotSession extends EventEmitter {
    // client: SteamUser; community: SteamCommunity
    constructor(client, community, log) {
        super();
        this.client = client;
        this.community = community;
        this.log = log || ((msg, type) => console.log(`[${type || 'info'}] ${msg}`));

        this.config = { restartGames: true, restartEveryMs: 180 * 60 * 1000, jitterMaxS: 60 };
        this.timers = { play: null, web: null };
        this.playingBlocked = false;
        this.currentGames = [];
        this.maxDisconnectsBeforePause = 5;
    }

    // ------------------------------------------------------------------
    // Presença / Jogos (SetGamesPlaying)
    // ------------------------------------------------------------------
    setGames(games, force = false) {
        this.currentGames = games || [];
        // O steam-user já faz o mapeamento p/ CMsgClientGamesPlayed (protobuf 742)
        this.client.gamesPlayed(this.currentGames, force);
        this.log(`${this.currentGames.length} jogo(s) setado(s) como em execução.`, 'info');
        if (this.timers.play) {
            clearInterval(this.timers.play);
            this.timers.play = null;
        }
        if (this.config.restartGames && this.currentGames.length > 0) {
            const jitter = Math.random() * (this.config.jitterMaxS * 1000);
            this.timers.play = setInterval(() => this._restartGames(), this.config.restartEveryMs + jitter);
            this.timers.play.unref && this.timers.play.unref();
        }
        this.emit('gamesStarted', this.currentGames);
    }

    stopGames() {
        this.currentGames = [];
        if (this.timers.play) { clearInterval(this.timers.play); this.timers.play = null; }
        this.client.gamesPlayed([]);
        this.emit('gamesStopped');
    }

    // RestartGames do HourBoostr: para por 5 min e recomeça — nos faz parecer humano
    _restartGames() {
        if (this.playingBlocked) return;
        this.client.gamesPlayed([]);
        this.log('Simulando humilde "fechamento" de jogos por 5 minutos... (HourBoostr RestartGames)', 'info');
        setTimeout(() => {
            if (this.currentGames.length > 0 && !this.playingBlocked) {
                this.client.gamesPlayed(this.currentGames);
                this.log('Jogos religados.', 'success');
            }
        }, 5 * 60 * 1000);
    }

    // ------------------------------------------------------------------
    // PlayingSessionState (ExtraHandler callback do HourBoostr)
    // ------------------------------------------------------------------
    wirePlayingBlocked() {
        this.client.on('playingState', (blocked, playingApp) => {
            if (blocked && !this.playingBlocked) {
                this.playingBlocked = true;
                this.log('Conta em uso por outra sessão. Idling pausado até liberar.', 'warning');
            } else if (!blocked && this.playingBlocked) {
                this.playingBlocked = false;
                if (this.currentGames.length) {
                    this.client.gamesPlayed(this.currentGames);
                    this.log('Conta liberada. Idling retomado.', 'success');
                }
            }
            this.emit('playingBlocked', blocked);
        });
    }

    // ------------------------------------------------------------------
    // Web session (VerifyCommunityConnection, a cada 15 min)
    // ------------------------------------------------------------------
    wireWebSessionRefresh() {
        if (this.timers.web) clearInterval(this.timers.web);
        this.timers.web = setInterval(async () => {
            // num projeto maior: community._jar + store verify. Aqui, logamos estado.
            if (this.community && this.community.steamID) {
                try {
                    this.emit('webRefresh', true);
                } catch (e) {
                    this.emit('webRefresh', false, e);
                }
            }
        }, 15 * 60 * 1000);
        this.timers.web.unref && this.timers.web.unref();
    }

    // ------------------------------------------------------------------
    // Rate limit handling de desconexão (Bot.cs::OnDisconnected)
    // ------------------------------------------------------------------
    async handleDisconnectLoop({ attempt, max }) {
        if (attempt >= this.maxDisconnectsBeforePause) {
            this.log('Muitas desconexões seguidas: dormindo 15 minutos antes de religar (anti rate-limit HourBoostr).', 'warning');
            await new Promise(r => setTimeout(r, 15 * 60 * 1000));
            return true; // resetou contador
        }
        return false;
    }

    destroy() {
        if (this.timers.play) clearInterval(this.timers.play);
        if (this.timers.web) clearInterval(this.timers.web);
    }
}

module.exports = { BotSession };
