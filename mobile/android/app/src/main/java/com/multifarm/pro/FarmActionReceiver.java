package com.multifarm.pro;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.AsyncTask;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Botões da notificação → POST direto no Node local (sem abrir o app).
 *   ⏸ Pausar    → POST /api/pause
 *   ▶ Continuar → POST /api/start  (body vazio retoma com config salva)
 *   ⏹ Desligar  → POST /api/stop
 */
public class FarmActionReceiver extends BroadcastReceiver {

    private static final String BASE_URL = "http://127.0.0.1:3000";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        String path;
        String body;
        if (FarmForegroundService.ACTION_PAUSE.equals(action)) {
            path = "/api/pause";
            body = "";
        } else if (FarmForegroundService.ACTION_RESUME.equals(action)) {
            path = "/api/start";
            body = "{}";
        } else if (FarmForegroundService.ACTION_STOP.equals(action)) {
            path = "/api/stop";
            body = "";
        } else {
            return;
        }

        // Requisições fora da main thread (regra do Android)
        new AsyncTask<Void, Void, Void>() {
            @Override
            protected Void doInBackground(Void... v) {
                post(path, body);
                return null;
            }
        }.execute();
    }

    private void post(String path, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(3000);
            c.setReadTimeout(5000);
            if (body != null && !body.isEmpty()) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                OutputStream os = c.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.close();
            }
            c.getResponseCode(); // dispara o POST
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
