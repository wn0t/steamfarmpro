# Steam Multi-Farm PRO

[![Node](https://img.shields.io/badge/node-%3E%3D18-blue)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Motor de **farm para Steam** com interface web/mobile — farm de horas (até 32 jogos simultâneos), farm de cartas automático e **desbloqueio de conquistas via rede Steam** (estilo SAM, sem rodar o .exe do jogo ou o cliente Steam aberto).

> ⚠️ **Use por sua conta e risco.** Ferramentas de idle/bot violam os [Termos de Serviço da Steam](https://store.steampowered.com/subscriber_agreement/). A Valve pode restringir ou banir contas que usam este tipo de software. Use em contas de teste.

## ✨ Funcionalidades

### 🖥 Aba Sessão — 3 métodos de login
| Método | Descrição |
|---|---|
| **Senha + Steam Guard** | Login clássico. Aceita código Steam Guard manual (prompt na UI) ou TOTP automático via `sharedSecret` (2FA 2FA sem celular) |
| **QR Code** | Gera QR Code via `steam-session`. Escaneie com o app Steam no celular, o backend captura a sessão automaticamente |
| **Cookie Web** | Cole o cookie `steamLoginSecure` do navegador. Motor entra em modo web (farm de cartas pela comunidade) |

O **refreshToken** das 3 formas é salvo criptografado no vault local e usado para
**auto-login** ao reabrir o app (não pede senha de novo).

### ⌚ Aba Painel — farm de horas e cartas
- **Farm de Horas**: até 32 AppIDs simultâneos + título customizado (`game_extra_info`)
- **Farm de Cartas**: scrape da página de badges via `steamcommunity`, ordena jogos com drops restantes (< 2h de jogo primeiro) e rotaciona a cada 30 min
- **Fluxo de botões exigido**: `🚀 Iniciar` → `⏸ Pausar` / `▶ Continuar` → `⏹ Desligar`
  - Logar **NÃO** liga o farm automaticamente
- Simulação de presença estilo HourBoostr: "reiniciar jogos" a cada ~3h (com jitter aleatório), pausa quando a conta é usada em outra sessão (`playingState`)

### 🏆 Aba Conquistas — SAM por rede
Igual ao Steam Achievement Manager, Mas **sem o .exe do jogo**:
- Consulta `EMsg.ClientGetUserStats` (818) → edita bits de `achievement_blocks`
- Envia `EMsg.ClientStoreUserStats` (820) com HMAC CRC correto → resposta 821 confirma
- Nome → índice de bit via Web API `ISteamUserStats/GetSchemaForGame` (mesma lógica do SteamAchievementUnlockerALL)
- Bulk Unlock: desbloqueia TODAS as conquistas de um jogo de uma vez
- Suporta unlock (✅) e lock (🔒) individuais
- Fallback "bit:N" para aceitar índice direto caso o jogo não esteja no schema

### 🔐 Segurança – Vault AES-256-GCM
- `config/login.json` é gravado cifrado (AES-256-GCM, IV aleatório por gravação)
- A chave fica em `config/login.key` (chmod 0600)
- Nada de senha em texto puro no repo

## 🚀 Como rodar (desktop / Termux)

```bash
git clone https://github.com/SEU_USUARIO/steam-multi-farm-pro.git
cd steam-multi-farm-pro
npm install
npm start
# abre em http://localhost:3000
```

### Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não (default `3000`) | Porta HTTP do motor |
| `STEAM_API_KEY` | **Sim, para conquistas** | Key da [Steam Web API](https://steamcommunity.com/dev/apikey) — necessária para mapear nome → bit de conquista |

### Estrutura do projeto
```
app.js                    # servidor HTTP + WebSocket + rotas REST
src/
├─ auth.js                # 3 métodos de login (senha/TOTP, QR, cookie web)
├─ bot-session.js         # presença, reconnect com backoff, rate limits, 32 jogos
├─ card-farm.js           # farm de cartas via scrape + rotação de fila
├─ achievements.js        # desbloqueio via protobuf (EMsg 818/820) + bulk
└─ credentials-vault.js   # AES-256-GCM para login.json
public/
└─ index.html             # UI Tailwind (Painel, Sessão, Conquistas)
mobile/
├─ ARCHITECTURE.md        # diagrama e passos de build do APK
├─ scripts/pack-engine.js # empacota o motor para o APK
└─ android/...            # FarmForegroundService.java + manifest
```

## 📱 Compilar APK Android

Guia completo e arquitetura em [`mobile/ARCHITECTURE.md`](mobile/ARCHITECTURE.md).

Resumo:
```bash
cd mobile
npm install                       # Capacitor + nodejs-mobile
npm run pack:engine               # copia app.js+src+public+node_modules p/ nodejs-project/
npx cap add android
npx cap sync android
npx cap open android              # abre no Android Studio → Run ▶
```

### Notificação Persistente (Foreground Service)
O APK traz um `FarmForegroundService` nativo (`dataSync`) que:

| Requisito | Como é implementado |
|---|---|
| **Ícone = foto Steam** | GET `/api/profile` → baixa `avatarUrl` → `builder.setLargeIcon(bitmap)` |
| **Conteúdo dinâmico** | GET `/api/state` a cada 30s → "Jogando CS2, Rust + 15 jogos..." (2 primeiros + count) |
| **Botões** | `⏸ Pausar` `▶ Continuar` `⏹ Desligar` via `PendingIntent.getBroadcast` → `FarmActionReceiver` → POST em `127.0.0.1:3000/api/{pause,start,stop}` |
| **Sobreviver ao Doze** | `START_STICKY` + `PARTIAL_WAKE_LOCK` + `WifiLock` + `foregroundServiceType="dataSync"` + `FOREGROUND_SERVICE_DATA_SYNC` |

O node.js embutido (`nodejs-mobile-capacitor`) roda o MESMO `app.js` numa thread isolada dentro do APK.

## 🛰 API REST do motor

| Rota | Método | Descrição |
|---|---|---|
| `/api/login/password` | POST | Login tradicional (user, password, sharedSecret?, guardCode?, remember?) |
| `/api/steamguard-code` | POST | Envia código Steam Guard manual |
| `/api/login/qr` | POST | Gera QR Code e inicia sessão |
| `/api/login/web` | POST | Login via cookie `steamLoginSecure` (modo web) |
| `/api/autologin` | POST | Auto-login com refreshToken salvo no vault |
| `/api/start` | POST | Inicia/retoma farm (exige login prévio) |
| `/api/pause` | POST | Pausa farm (não conta horas) |
| `/api/stop` | POST | Desliga farm (mantém sessão salva) |
| `/api/logout` | POST | Desloga e APAGA credenciais salvas |
| `/api/state` | GET | Estado completo do motor |
| `/api/profile` | GET | steamId, nome e avatarUrl (usado pela notificação) |
| `/api/achievements` | POST | Unlock/lock 1 conquista (`{appId, achievementId, mode}`) |
| `/api/achievements/bulk` | POST | Bulk unlock todas |
| `/api/achievements/schema/:appId` | GET | Lista conquistas do jogo |
| WebSocket `state` | — | Estado push em tempo real |
| WebSocket `log` | — | Log de eventos colorido |

## 🧬 Protocolo Steam usado pelas conquistas

O núcleo da parte de conquistas segue exatamente o fluxo do SAM (C#), portado:

```text
RequestUserStats(steamId)          ← SteamKit2 / steam-user via _send()
  ↓ EMsg.ClientGetUserStats (818)
  ↓ CMsgClientGetUserStatsResponse {stats[], achievement_blocks[]}
SetAchievement(name, boolean)      ← SAM by-bit → Mapeia via GetSchemaForGame
  ↓ edita bit N do stat_id=0
StoreStats()                       ← SAM
  ↓ EMsg.ClientStoreUserStats (820) com CRC32
  ↓ CMsgClientStoreUserStatsResponse (821): eresult==1 confirma
```

Sem `.exe`, sem cliente Steam oficial aberto. Tudo pela rede do CM.

## 📜 Licença

MIT — veja [LICENSE](LICENSE).
Este projeto é educacional, sem afiliação com a Valve. Uso comercial não recomendado.
