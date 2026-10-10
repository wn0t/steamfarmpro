# Steam Multi-Farm PRO — APK Android (Etapa 3)

## Arquitetura geral

```
┌──────────────────────────────────────────────────────────┐
│ APK Android (Capacitor)                                  │
│                                                          │
│  WebView (Tailwind UI — public/index.html)                │
│      ▲  HTTP/WS p/ localhost:3000                        │
│      │                                                   │
│  Node.js Embedded (nodejs-mobile-capacitor)               │
│      └─ app.js completo (motor Steam) em thread isolada   │
│                                                          │
│  Foreground Service (Java)                               │
│      • Notificação persistente (avataar + dinâmica)      │
│      • Botões: ⏸ Pausar / ▶ Continuar / ⏹ Parar          │
│      • Ponte → HTTP localhost:3000/api/*                 │
└──────────────────────────────────────────────────────────┘
                       ↕ TLS
                    Rede Steam
```

**Por que NodeJS-Mobile?** O motor completo (websocket p/ CM da Steam, protobuf,
crypto AES) roda inalterado dentro do APK em uma thread isolada. A UI é a MESMA
página web que já existe hoje no desktop. O Foreground Service nativo Java
informa o Android que o app está "vivo" e é ele quem mostra a notificação que o
sistema não mata (requisito Android 8+ para processos exigentes, como um CM
socket aberto à Steam).

---

## 1. Estrutura de pastas a criar

```
mobile/
├─ capacitor.config.json
├─ package.json            (só o Capacitor + plugin)
├─ android/                (gerado por npx cap add android)
└─ nodejs-project/         (o backend EMPACOTADO)
   ├─ app.js
   ├─ src/...
   ├─ public/index.html    (UI é servida pelo Node também aqui)
   ├─ package.json         (DENTRO: dependências puro-JS, file:steam-*)
   └─ node_modules/        (bundled no APK via nodejs-mobile)
```

## 2. Passos de build

```bash
# 1) Instalar Node no projeto mobile
cd mobile
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android
npm i nodejs-mobile-capacitor

# 2) Empacotar o motor (script copia app.js+src+public+deps p/ nodejs-project)
npm run pack:engine     # script mostrado no package.json abaixo

# 3) Adicionar plataforma Android
npx cap add android
npx cap sync android

# 4) Abrir no Android Studio e dar Run ▶ (ou ./gradlew assembleRelease)
npx cap open android
```

## 3. `mobile/capacitor.config.json`

```json
{
  "appId": "com.multifarm.pro",
  "appName": "Steam Multi-Farm",
  "webDir": "www",
  "server": { "androidScheme": "https" },
  "plugins": {
    "NodeJS": {
      "nodePath": "nodejs-project"
    }
  }
}
```

## 4. `mobile/package.json`

```json
{
  "name": "steam-multi-farm-mobile",
  "private": true,
  "scripts": {
    "pack:engine": "node scripts/pack-engine.js",
    "cap:sync": "npm run pack:engine && npx cap sync android"
  },
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/cli": "^6.0.0",
    "@capacitor/android": "^6.0.0",
    "nodejs-mobile-capacitor": "^4.0.0"
  }
}
```

## 5. Pulse/Foreground Service nativo

Criar em `mobile/android/app/src/main/java/com/multifarm/pro/FarmForegroundService.java`.

O Foreground Service precisa:
1. **iniciar** com `startForeground(NOTIF_ID, notification)` imediatamente após `onCreate` (Android exige < 5s)
2. **atualizar** a notificação por `NotificationManager.notify(NOTIF_ID, builder.build())` a cada evento relevant do WebSocket or post no /api/state
3. **expor botões** via `NotificationCompat.Builder.addAction(...)` retornando `PendingIntent.getBroadcast(...)` — receiver interno responde fazendo POST ao `http://127.0.0.1:3000/api/pause|stop|start`
4. **permissão** `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` no AndroidManifest (+ API 34 requisito `android:foregroundServiceType="dataSync"`)

**Canais** — requirido a partir do Android 8:
```java
NotificationChannel ch = new NotificationChannel("farm", "Farm Steam", NotificationManager.IMPORTANCE_LOW);
ch.setDescription("Status do farm Steam");
getSystemService(NotificationManager.class).createNotificationChannel(ch);
```

**Ícone da foto de perfil**: após login bem-sucedido, o backend já tem cookies
Steam; implementar no motor a rota extra `/api/profile/avatar` que retorna URL
da foto (`https://avatars.akamai.steamstatic.com/<hash>_full.jpg`). No Android,
usar Coil/Glide no service para baixar a imagem e aplicá-la como
`NotificationCompat.Builder.setLargeIcon(bitmap)` +
`setSmallIcon(R.mipmap.ic_launcher)`.

**Conteúdo dinâmico dos jogos** — o service consulta `GET /api/state` a cada
30s (ou subscriNotification via WebSocket socket.io: ouvindo evento `state`) e
renderiza:
```java
String text;
if (games.size() > 2) {
    text = "Jogando " + games.get(0) + ", " + games.get(1) + " + " + (games.size() - 2) + " jogos...";
} else {
    text = "Jogando " + String.join(", ", games);
}
builder.setContentText(text);
```
(As "nomes bonitos" dos jogos vêm de `GET /api/appnames?ids=730,440` — adicionar
no motor: usa PICS cache do steam-user `client.getProductInfo(appIds)`, já
habilitado no projeto com `enablePicsCache: true`).

**Ações interativas** (não precisa abrir o app — POST direto ao Node local):
```java
Intent pauseIntent = new Intent(context, FarmActionReceiver.class)
        .setAction("PAUSE");
builder.addAction(0, "⏸ Pausar",
        PendingIntent.getBroadcast(context, 1, pauseIntent, PendingIntent.FLAG_IMMUTABLE));

// FarmActionReceiver.java
public void onReceive(Context c, Intent i) {
    String url = "http://127.0.0.1:3000/api/" + i.getAction().toLowerCase();
    // OkHttp POST → Node Server (que NUNCA dorme pois está dentro do FS!)
}
```

## 6. Sobrevivência ao Doze Mode

O projeto node dentro do `foreground service` com `dataSync` sobrevive a:
- Tela desligada (WiFi mantido via `WifiManager.WifiLock`)
- CPU suspensa (via `PowerManager.PartialWakeLock`, cuidado com bateria)
- Fechar o app da multitarefa (serviço `START_STICKY` reinicia o Node embutido)

Para usuários exigentes: guiar o usuário a desligar otimização de bateria para
o app em `Configurações → Bateria → Sem otimização` (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`).

## 7. Checklist de produção do APK

- [ ] `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` + `POST_NOTIFICATIONS` no manifest
- [ ] `android:usesCleartextTraffic="true"` (Node local roda em HTTP puro no 127.0.0.1)
- [ ] Testar em Android 14 (API 34): notification permission runtime
- [ ] Testar em Android 8 (API 26): canais de notificação
- [ ] Ofuscação de credenciais (vault já criptografa AES-256-GCM em `config/`)
- [ ] Termos: lembrar que usar conta principal em geradores de tempo só em contas testes

## 8. Alternativa pesada: "Node.js for Mobile Apps"

Se um dia o nodejs-mobile-capacitor limitar nativamente pelo lado do Java,
usar: <https://github.com/janeasystems/nodejs-mobile> diretamente — é o runtime
oficial Node 18 embutido Android/iOS, mesmas APIs (`nodejs.startWithScript(f)`).
A recomendação: começe no Capacitor, pois integração WebView/Service nativa é
mais simples.
