package com.multifarm.pro;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * FOREGROUND SERVICE (Etapa 3) — requisitos atendidos:
 *  1. Notificação persistente na barra do Android com:
 *     • Ícone: foto de perfil Steam (GET /api/profile → avatarUrl)
 *     • Conteúdo dinâmico: nomes dos jogos ("Jogando CS2, Rust + 15 jogos...")
 *     • Botões: ⏸ Pausar / ▶ Continuar / ⏹ Desligar
 *  2. Botões postam direto no Node local (127.0.0.1:3000) sem abrir o app.
 *  3. Sobrevive a Doze: WakeLock parcial + WifiLock + START_STICKY + tipo dataSync.
 */
public class FarmForegroundService extends Service {

    public static final String CHANNEL_ID = "farm_steam";
    public static final int NOTIF_ID = 1337;

    private static final String BASE_URL = "http://127.0.0.1:3000";
    private static final String ACTION_PAUSE = "com.multifarm.pro.PAUSE";
    private static final String ACTION_RESUME = "com.multifarm.pro.RESUME";
    private static final String ACTION_STOP = "com.multifarm.pro.STOP";

    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String lastAvatarUrl = null;
    private Bitmap avatarBitmap = null;
    private String lastTitle = "Steam Multi-Farm";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        // Android exige startForeground imediatamente (máx. 5s após onCreate)
        startForeground(NOTIF_ID, buildNotification("Iniciando motor...", false));

        startLocks();
        scheduler.scheduleWithFixedDelay(this::refresh, 2, 30, TimeUnit.SECONDS);
    }

    private void startLocks() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MultiFarm:node");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "MultiFarm:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Farm Steam", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Status do farm Steam em execução");
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    // ------------------------------------------------------------------
    // Loop de refresh: consulta /api/profile e /api/state no Node local
    // ------------------------------------------------------------------
    private void refresh() {
        try {
            JSONObject state = httpGetJson(BASE_URL + "/api/state");
            if (state == null) return;
            boolean farming = state.optBoolean("isFarming", false);
            boolean paused = state.optBoolean("isPaused", false);
            boolean loggedIn = state.optBoolean("loggedIn", false);

            // Tenta pegar avatar + nome jogáveis
            JSONObject profile = httpGetJson(BASE_URL + "/api/profile");
            if (profile != null) {
                lastTitle = profile.optString("name", lastTitle);
                String avatarUrl = profile.optString("avatarUrl", null);
                if (avatarUrl != null && !avatarUrl.equals(lastAvatarUrl)) {
                    lastAvatarUrl = avatarUrl;
                    avatarBitmap = httpGetBitmap(avatarUrl);
                }
            }

            String text = buildContent(state, farming, paused, loggedIn);
            main.post(() -> {
                NotificationManager nm = getSystemService(NotificationManager.class);
                nm.notify(NOTIF_ID, buildNotification(text, farming, paused, loggedIn));
            });
        } catch (Exception ignored) {
        }
    }

    private String buildContent(JSONObject st, boolean farming, boolean paused, boolean loggedIn) {
        if (!loggedIn) return "Conta não autenticada — abra o app.";
        if (paused) return "⏸ Farm pausado";
        if (!farming) return "Sessão ativa — pressione Iniciar no app.";

        String custom = st.optString("customTitle", "");
        String[] titles = null;
        Object gamesObj = st.opt("gameNames");
        if (gamesObj instanceof JSONArray) {
            JSONArray arr = (JSONArray) gamesObj;
            titles = new String[arr.length()];
            for (int i = 0; i < arr.length(); i++) titles[i] = arr.optString(i);
        }
        if (titles == null || titles.length == 0) {
            return custom.isEmpty() ? "Guardando jogos configurados..." : "Jogando " + custom;
        }
        if (titles.length == 1) return "Jogando " + titles[0];
        if (titles.length == 2) return "Jogando " + titles[0] + ", " + titles[1];
        return "Jogando " + titles[0] + ", " + titles[1] + " + " + (titles.length - 2) + " jogos...";
    }

    // ------------------------------------------------------------------
    // Notificação
    // ------------------------------------------------------------------
    private Notification buildNotification(String text, boolean farming, boolean paused, boolean loggedIn) {
        Intent tap = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pTap = PendingIntent.getActivity(this, 0, tap, PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(lastTitle)
                .setContentText(text)
                .setContentIntent(pTap)
                .setOngoing(true)
                .setSilent(true)
                .setOnlyAlertOnce(true);

        if (avatarBitmap != null) b.setLargeIcon(avatarBitmap);

        boolean farmingNow = farming && !paused;
        if (farmingNow) {
            // [⏸ Pausar] [⏹ Desligar]
            b.addAction(action("$pause", ACTION_PAUSE, 1, "⏸ Pausar"));
            b.addAction(action("$stop", ACTION_STOP, 3, "⏹ Desligar"));
        } else if (farming && paused) {
            // [▶ Continuar] [⏹ Desligar]
            b.addAction(action("$resume", ACTION_RESUME, 2, "▶ Continuar"));
            b.addAction(action("$stop", ACTION_STOP, 3, "⏹ Desligar"));
        } else if (loggedIn) {
            // [▶ Iniciar]
            b.addAction(action("$resume", ACTION_RESUME, 2, "▶ Continuar"));
        }
        return b.build();
    }

    private PendingIntent action(String extra, String act, int code, String labelIgnored) {
        Intent i = new Intent(this, FarmActionReceiver.class).setAction(act).putExtra("cmd", extra);
        return PendingIntent.getBroadcast(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification(String text, boolean farming) {
        return buildNotification(text, farming, false, true);
    }

    // ------------------------------------------------------------------
    // HTTP para o Node local
    // ------------------------------------------------------------------
    private JSONObject httpGetJson(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(5000);
            InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream();
            byte[] buf = new byte[8192];
            StringBuilder sb = new StringBuilder();
            int n;
            while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            in.close();
            String s = sb.toString().trim();
            return s.startsWith("{") ? new JSONObject(s) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private Bitmap httpGetBitmap(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            InputStream in = c.getInputStream();
            Bitmap b = BitmapFactory.decodeStream(in);
            in.close();
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: se o Android matar, o serviço (e o Node embutido) volta
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (wakeLock != null) wakeLock.release();
        if (wifiLock != null) wifiLock.release();
        scheduler.shutdownNow();
    }
}
