# Steam Multi-Farm PRO

[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Windows%20%7C%20Linux%20%7C%20Termux-blue)](#) [![Node](https://img.shields.io/b/node-%3E%3D18-blue)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Open Source](https://img.shields.io/badge/100%25-open--source-Yes-green)](#)

**Steam Multi-Farm PRO** é um app **open-source, 100% gratuito e que roda 100% LOCAL no seu aparelho/computador — sem servidor externo, sem cadastro, sem coleta de dados**. O motor completo (Node.js + Steam CM) roda dentro do próprio APK (ou no seu terminal); a interface é o único ponto de contato.

Ele faz **farm de horas** (até 32 jogos simultâneos), **farm de cartas automático** e **desbloqueio de conquistas via rede Steam** (estilo SAM, sem rodar o .exe do jogo ou o cliente Steam aberto).

> ⚠️ **Use por sua conta e risco.** Ferramentas de idle/bot violam os [Termos de Serviço da Steam](https://store.steampowered.com/subscriber_agreement/). A Valve pode restringir ou banir contas que usam este tipo de software. Prefira contas de teste.

---

## 📱 APK Android — instalou, abriu, funcioanando

O APK embute um **Node.js 18 runtime** (`@capawesome/capacitor-nodejs` + nodejs-mobile), então o motor inteiro roda dentro do próprio app — **não precisa de servidor externo, precisando só da internet** para falar com a Steam.

**APK assinado pronto:** [`Steam-Multi-Farm-PRO-v3.0.0.apk`](Steam-Multi-Farm-PRO-v3.0.0.apk) (~175 MB, inclui libs ARM64 + ARMv7 + x86_64)

**Assinatura:**
```
Certificado: SHA-256 33f33b0472b0a4aa8b3dd21cca9793618b5b5acc003a2a37a3a4a8f71392f67a
Keystore: mobile/keystore/multifarm.keystore (senha multifarm123)
```

### 🔔 Notificação persistente nativa

Abrindo o APK, o `FarmForegroundService` Android é iniciado automaticamente e mantém uma **notificação permanente** na barra de status com:

| Elemento | Como é implementado |
|---|---|
| **Ícone = sua foto de perfil Steam** | `GET /api/profile` → baixa `avatarUrl` → `builder.setLargeIcon(bitmap)` (atualiza a cada 20s) |
| **Título = seu nome Steam** | Mesma rota `/api/profile` (`name`) |
| **Jogos sendo jogados** | Consulta `GET /api/gameNames` (motor resolve via PICS cache do Steam) a cada 20s: **"Jogando Counter-Strike 2, Rust + 15 jogos…"** (2 primeiros + count) ou **"⏸ Farm pausado"** / **"Sessão ativa — pressione Iniciar"** |
| **Botões na notificação** | `▶ Iniciar` / `⏸ Pausar` / `▶ Continuar` / `⏹ Desligar` — clicam direto na notificação (via `FarmActionReceiver` → `POST http://127.0.0.1:32123/api/{start\|pause\|stop}`), **sem abrir o app** |
| **Sobrevive a Doze / fechar app** | `START_STICKY`, `PARTIAL_WAKE_LOCK`, `WifiLock`, `foregroundServiceType="dataSync"`, `stopWithTask="false"` |

Botões mostrados conforme o estado:
- **Conta logada, farm parado** → `▶ Iniciar`
- **Farmando** → `⏸ Pausar` + `⏹ Desligar`
- **Pausado** → `▶ Continuar` + `⏹ Desligar`

### 🖼 Ícone do app
Lua crescente sobre círculo azul-escuro (estilo Steam), gerada proceduralmente por [`mobile/icons/gen_icons.py`](mobile/icons/gen_icons.py) nas densidades mdpi…xxxhdpi + adaptive icon Android 8+.

---

## ✨ Funções reais do app

### 💻 Roda LOCAL — 3 formas
| Ambiente | Como |
|---|---|
| **Android APK** | Node.js embutido no app (`mobile/www/nodejs`), UI WebView abre `http://127.0.0.1:32123` |
| **PC / Servidor** | `npm install && npm start` → abre `http://localhost:3000` |
| **Termux (Android)** | Mesmo comando do PC — o motor roda no cliente e a UI no navegador |

### 🖥 Aba Sessão — 3 métodos de login
| Método | Descrição |
|---|---|
| **Senha + Steam Guard** | Login clássico. Aceita código Steam Guard manual (prompt na UI) ou TOTP automático via `sharedSecret` (2FA sem celular) |
| **QR Code** | Gera QR Code via `steam-session`. Escaneie/aprove com o app Steam no celular, o backend captura a sessão automaticamente |
| **Cookie Web** | Cole o cookie `steamLoginSecure` do navegador. Motor entra em modo web (farm de cartas pela comunidade) |

O **refreshToken** das 3 formas é salvo **criptografado AES-256-GCM** no vault local e usado para **auto-login** ao reabrir o app (não pede senha de novo).

### ⌚ Aba Painel — farm de horas e cartas
- **Farm de Horas**: até 32 AppIDs simultâneos + título customizado (`game_extra_info`)
- **Farm de Cartas**: scrape da página de badges via `steamcommunity`, prioriza jogos com < 2h de jogo e mais drops restantes; rotaciona a cada 30 min
- **Fluxo de botões**: `🚀 Iniciar` → `⏸ Pausar` / `▶ Continuar` → `⏹ Desligar` — logar **NÃO** liga o farm automaticamente; está em sincronia com os botões da notificação
- Simulação de presença estilo HourBoostr: "reinicia jogos" a cada ~3h (com jitter), pausa se a conta for usada em outra sessão (`playingState`)
- Auto-reconexão com backoff progressivo; após 5 desconexões, dorme 15 min (anti rate-limit)

### 🏆 Aba Conquistas — SAM por rede
Igual ao Steam Achievement Manager, mas **sem o .exe do jogo e sem o cliente Steam aberto**:
- Consulta `EMsg.ClientGetUserStats` (818) → edita bits de `achievement_blocks`
- Envia `EMsg.ClientStoreUserStats` (820) com CRC32 correto → resposta 821 confirma
- Nome → índice de bit via Web API `ISteamUserStats/GetSchemaForGame`
- Bulk Unlock: desbloqueia TODAS as conquistas de um jogo de uma vez
- Suporta unlock (✅) e lock (🔒) individuais
- Fallback `"bit:N"` para aceitar índice direto caso o jogo não esteja no schema

> 📌 Para as conquistas, é preciso configurar a **`STEAM_API_KEY`** (gratuíta) da [Steam Web API](https://steamcommunity.com/dev/apikey) para o jogo (método de sucesso garantido — sem ela, usar o fallback `bit:N`).

### 🔐 Segurança — Vault AES-256-GCM
- As credenciais vão em `login.json` cifrado (AES-256-GCM, IV aleatório por gravação)
- A chave fica em `login.key` (chmod 0600; no Android, dentro do `app.datadir()` — sandbox privado)
- Nada de senha em texto puro no repo
- No Android, os dados persistem no diretório privado do app (sobrevivem a reiniciar o celular e atualizar o APK)

---

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
| `STEAM_API_KEY` | Sim para conquistas | Key gratuita da [Steam Web API](https://steamcommunity.com/dev/apikey) — mapeia nome → bit de conquista |
| `MULTIFARM_DATA_DIR` | Não | Diretório de dados alternativo (Android injeta `app.datadir()` do plugin) |

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
├─ capacitor.config.json  # Capacitor + plugin Nodejs (startMode auto)
├─ www/
│  ├─ index.html          # loader WebView → redireciona p/ motor local
│  └─ nodejs/             # motor empacotado (app.js + node_modules)
├─ scripts/pack-engine.js # empacota o motor p/ o APK
├─ icons/                 # gerador de ícones (lua crescente) + PNGs
├─ keystore/              # keystore de assinatura
└─ android/               # projeto nativo (FarmForegroundService, manifest, ícones)
Steam-Multi-Farm-PRO-v3.0.0.apk  # APK assinado final
```

## 📱 Compilar APK Android

Requisitos: JDK 21, Android SDK 36 (command-line tools bastam, Android Studio não é necessário).

```bash
# 1) preparar motor embutido
cd mobile
npm install
npm run pack:engine          # copia app.js+src+public+node_modules p/ www/nodejs/

# 2) sincronizar com Android
npx cap sync android

# 3) build (debug ou release)
cd android
./gradlew assembleDebug      # debug APK
./gradlew assembleRelease    # release APK assinado (usa keystore.properties)

# APK sai em:
#   app/build/outputs/apk/debug/app-debug.apk
#   app/build/outputs/apk/release/app-release.apk
```

### Arquitetura do APK
```
┌──────────────────────────────────────────────────────────┐
│ APK Android (Capacitor 8)                                │
│                                                          │
│  WebView (loader minimalista)                            │
│      ▲  HTTP → 127.0.0.1:32123                           │
│      │                                                   │
│  Node.js Embedded (nodejs-mobile 18.20.4)                │
│      └─ app.js completo — FICARIA no app.datadir()       │
│         credenciais criptografadas AES-256-GCM           │
│      │                                                   │
│  FarmForegroundService (nativo Java)                     │
│      • Notificação persistente (avatar + jogos + botões) │
│      • WakeLock + WifiLock + START_STICKY (anti Doze)    │
└──────────────────────────────────────────────────────────┘
                       ↕ TLS
                    Rede Steam (CM + web/community)
```

---

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
| `/api/gameNames` | GET | Nomes dos jogos em farm (PICS; usado pela notificação) |
| `/api/achievements` | POST | Unlock/lock 1 conquista (`{appId, achievementId, mode}`) |
| `/api/achievements/bulk` | POST | Bulk unlock todas |
| `/api/achievements/schema/:appId` | GET | Lista conquistas do jogo |
| WebSocket `state` | — | Estado push em tempo real |
| WebSocket `log` | — | Log de eventos colorido |

---

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

---

## 🧪 Testar o APK rápido

1. **Instalar** o APK (habilitar "fontes desconhecidas")
2. **Abrir o app** — a notificação aparece imediatamente, dizendo "Sessão ativa — pressione Iniciar"
3. **Logar** com senha (+ Steam Guard) ou **QR Code** no celular
4. **Na notificação** (ou no Painel) apertar `▶ Iniciar`
5. A notificação passa a mostrar **"Jogando {nome do jogo 1}, {jogo 2} + X jogos…"**
6. Os botões **⏸ Pausar / ⏹ Desligar** funcionam direto da notificação — mesmo com o app fechado / tela off
7. Fechar o app da multitarefa: o **Foreground Service** mantém o Node.js vivo; reabrir continua logado (auto-login com refreshToken)

---

## 📜 Licença

MIT — veja [LICENSE](LICENSE).
Este projeto é 100% **open-source**, educacional, sem afiliação com a Valve. Uso comercial não recomendado.
Contribuições são bem-vindas — abra uma issue ou PR!
