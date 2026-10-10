'use strict';

// Etapa 2 - Métodos de Autenticação Avançada.
// 1. Tradicional (senha + Steam Guard: TOTP via shared secret OU código manual)
// 2. QR Code (steam-session startWithQR → usuário escaneia no app móvel)
// 3. Web OAuth simulado (cookies steamLoginSecure colados na UI / WebView)
//
// Em todos os casos o motor reduz a isso: obtemos (a) um refreshToken válido,
// (b) steamID, e passamos ao steam-user via client.logOn({ refreshToken })
// (método moderno do steam-user v5). Cookies web (steamLoginSecure) derivam de
// session.getWebCookies() — funciona para WebBrowser e MobileApp.

const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const qrcode = require('qrcode');
const SteamTotp = require('steam-totp');

class AuthManager {
    // log: função global logToUI(message, type)
    // onSessionReady(sessionInfo) → chamada com { refreshToken, steamID64, accountName? }
    constructor(log, onSessionReady) {
        this.log = log;
        this.onSessionReady = onSessionReady;
        this._qrSession = null;
    }

    // ------------------------------------------------------------------
    // MÉTODO 1 - Tradicional (senha + Steam Guard)
    // ------------------------------------------------------------------
    // sharedSecret  → gera TOTP automaticamente (5f chars)
    // guardCode     → código Steam Guard digitado manualmente pelo usuário
    //
    // Estratégia: sempre usamos steam-session (novo protocolo EResult/
    // accessToken) pois o steam-user v5 exige refreshToken moderno.
    async loginWithPassword({ username, password, sharedSecret, guardCode }) {
        const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
        if (sharedSecret) {
            session.sharedSecret = sharedSecret; // steam-session gera o TOTP sozinho a cada poll
        }

        session.on('remoteInteraction', () => {
            this.log('⚠ Steam Guard aprovado em outra sessão — confirme no caso na tela (remoteInteraction).', 'warning');
        });

        if (guardCode) {
            // código Steam Guard de e-mail (validade de 5 letras) OU código TOTP 5 dígitos manual
            session.steamGuardCode = guardCode;
        } else if (sharedSecret) {
            // gera agora via steam-totp (steam-session também geraria mas assim é explícito)
            session.steamGuardCode = SteamTotp.generateAuthCode(sharedSecret);
        }

        const result = await session.startWithCredentials({ accountName: username, password });
        if (!result.actionRequired) {
            // login sem 2FA
            return this._finishPasswordLogin(session);
        }

        if (result.validActions.some(a => a.type === EAuthSessionGuardType.DeviceCode || a.type === EAuthSessionGuardType.EmailCode)) {
            throw new Error('GUARD_CODE_REQUIRED'); // o FE solicita o prompt ao usuário
        }
        throw new Error('Método de confirmação não suportado: ' + JSON.stringify(result.validActions));
    }

    // Submete código Steam Guard num login pendente
    async submitGuardCode(code) {
        if (!this._pendingSession) throw new Error('Nenhum login pendente de código.');
        try {
            await this._pendingSession.submitSteamGuardCode(code);
            return this._finishPasswordLogin(this._pendingSession);
        } catch (e) {
            throw new Error('Código inválido: ' + e.message);
        }
    }

    async _finishPasswordLogin(session) {
        this._pendingSession = null;
        await this._emitReady(session, 'senha');
    }

    // ------------------------------------------------------------------
    // MÉTODO 2 - QR Code
    // ------------------------------------------------------------------
    async beginQrLogin() {
        if (this._qrSession) this._cancelQr();
        this._qrSession = new LoginSession(EAuthTokenPlatformType.SteamClient);
        this._qrSession.on('remoteInteraction', () => {
            this.log('📱 Steam requesita interação remota (QR escaneado). Aguardando confirmação no celular...', 'info');
        });

        const start = await this._qrSession.startWithQR(); // devolve { qrChallengeUrl }
        // qrChallengeUrl é um link https://s.team/q/... que o app Steam escaneia/aprrova
        const qrDataUrl = await qrcode.toDataURL(start.qrChallengeUrl, { width: 240, margin: 1 });

        this._qrSession.on('authenticated', async () => {
            this.log('✅ QR Code aprovado! Capturando sessão automaticamente...', 'success');
            try {
                await this._emitReady(this._qrSession, 'qrcode');
            } finally {
                this._qrSession = null;
            }
        });

        this._qrSession.on('timeout', () => {
            this.log('⌛ QR Code expirou. reinicie no painel.', 'error');
            this._qrSession = null;
            this.emit && this.emit('qrTimeout');
        });

        this.log('QR Code gerado — escaneie com o app Steam no celular (ou abra a URL).', 'info');
        return { qrDataUrl, challengeUrl: start.qrChallengeUrl };
    }

    _cancelQr() {
        if (this._qrSession) {
            try { this._qrSession.cancelLoginAttempt(); } catch (_) {}
            this._qrSession = null;
        }
    }

    // ------------------------------------------------------------------
    // MÉTODO 3 - Web /Cookies (steamLoginSecure colado do WebView)
    // ------------------------------------------------------------------
    // O usuário cola a linha completa "steamLoginSecure=765611980xxxxxx||eyJ...".
    // Tratamos: steamID + token de web → não dá para logar client com isso
    // direto, então convertemos para sessão via refresh_token quando possível.
    // Estratégia segura: parse + logOn({ refreshToken: null }) NÃO funciona —
    // logo, o motor funciona no contexto WEB (modo cartas/achievements via cookies).
    async loginWithWebCookie(steamLoginSecureRaw) {
        const m = /steamLoginSecure=(\d+)\|\|(eyJ[^;]+)/.exec(steamLoginSecureRaw);
        if (!m) throw new Error('Formato inválido. Cole a linha inteira steamLoginSecure=STEAMID||TOKEN (do cookie do navegador).');
        const steamId64 = m[1];
        const accessToken = m[2];
        // accessToken aqui é o valor do cookie (JWT de acesso). Regeneramos refresh
        // token não é possível via só cookie — o motor entra em "modo web" limitado.
        this.log('Sessão web reconhecida (steamLoginSecure válido).', 'success');
        const info = { steamId64, accessToken, mode: 'web' };
        this.onSessionReady(info);
        return info;
    }

    // ------------------------------------------------------------------
    // Finalização comum de qualquer método: sessão steam-session→motor
    // ------------------------------------------------------------------
    async _emitReady(session, method) {
        // refresh token do steam-session é o ingrediente moderno que o steam-user consome
        const refreshToken = session.refreshToken;
        const steamId64 = session.steamID ? session.steamID.getSteamID64() : null;
        if (!refreshToken) throw new Error('Sessão autenticada sem refresh token (inesperado).');

        let accountName = null;
        try {
            const cookies = await session.getWebCookies();
            // cookies[] = ['steamLoginSecure=...','steamRefresh_steam=...','sessionid=...']
            for (const c of cookies) {
                if (c.startsWith('steamLoginSecure=')) {
                    const m = /steamLoginSecure=(\d+)\|\|/.exec(decodeURIComponent(c));
                    if (m) accountName = m[1];
                }
            }
        } catch (e) {
            this.log('Não foi possível derivar cookies web da sessão: ' + e.message, 'warning');
        }

        this.log(`Sessão pronta (método ${method}).`, 'success');
        this.onSessionReady({ refreshToken, steamId64, accountName, method });
        return { refreshToken, steamId64, accountName, method };
    }
}

// steam-session constant (não exportamos diretamente para evitar versão drift)
const EAuthSessionGuardType = require('steam-session').EAuthSessionGuardType || {
    None: 1, EmailCode: 2, DeviceCode: 3, DeviceConfirmation: 4, DeviceApproval: 5, EmailConfirmation: 6, MachineToken: 7
};

module.exports = { AuthManager };
