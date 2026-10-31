package br.meutube.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Serviço em primeiro plano que mantém o MeuTube tocando com o app fechado ou a tela apagada.
// Mostra a notificação com os controles e responde à tela de bloqueio, ao fone e ao Bluetooth (MediaSession).
// O som em si continua sendo tocado pela tela (WebView); este serviço só impede o Android de parar o app.
public class MediaService extends Service {
    static final String ACTION_UPDATE = "br.meutube.app.UPDATE";
    static final String ACTION_STOP = "br.meutube.app.STOP";
    private static final String ACTION_BUTTON = "br.meutube.app.BUTTON";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;
    static boolean running = false;

    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String artUrl = "";
    private Bitmap art;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Tocando agora", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "MeuTube");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { MeuTubeMediaPlugin.sendAction("play"); }
            @Override public void onPause() { MeuTubeMediaPlugin.sendAction("pause"); }
            @Override public void onSkipToNext() { MeuTubeMediaPlugin.sendAction("next"); }
            @Override public void onFastForward() { MeuTubeMediaPlugin.sendAction("forward"); }
            @Override public void onRewind() { MeuTubeMediaPlugin.sendAction("back"); }
            @Override public void onStop() { MeuTubeMediaPlugin.sendAction("pause"); }
        });
        session.setSessionActivity(openApp());
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MeuTube:playback");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MeuTube:playback");
        wifiLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_UPDATE;
        if (ACTION_BUTTON.equals(action)) {
            String b = intent.getStringExtra("b");
            if ("close".equals(b)) {
                MeuTubeMediaPlugin.sendAction("pause");
                stopEverything();
                return START_NOT_STICKY;
            }
            MeuTubeMediaPlugin.sendAction(b);
        }
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }
        refresh();
        return START_NOT_STICKY;
    }

    private void refresh() {
        MediaState s = MediaState.get();
        if (!s.artwork.equals(artUrl)) loadArt(s.artwork);

        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist);
        if (art != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_FAST_FORWARD | PlaybackStateCompat.ACTION_REWIND | PlaybackStateCompat.ACTION_STOP
                | (s.canNext ? PlaybackStateCompat.ACTION_SKIP_TO_NEXT : 0);
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(s.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());

        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_meutube)
                .setContentTitle(s.title)
                .setContentText(s.artist)
                .setLargeIcon(art)
                .setContentIntent(openApp())
                .setDeleteIntent(button("close", 9))
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(s.playing)
                .addAction(android.R.drawable.ic_media_rew, "Voltar 10 s", button("back", 1))
                .addAction(s.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        s.playing ? "Pausar" : "Tocar", button(s.playing ? "pause" : "play", 2))
                .addAction(android.R.drawable.ic_media_ff, "Avançar 10 s", button("forward", 3));
        if (s.canNext) n.addAction(android.R.drawable.ic_media_next, "Próximo", button("next", 4));
        n.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Fechar", button("close", 5));
        n.setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        Notification notification = n.build();

        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);

        // Segura o processador e o Wi-Fi acordados só enquanto toca.
        if (s.playing) {
            wakeLock.acquire(6 * 60 * 60 * 1000L);
            wifiLock.acquire();
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock.isHeld()) wifiLock.release();
        }
    }

    private PendingIntent button(String b, int code) {
        Intent i = new Intent(this, MediaService.class).setAction(ACTION_BUTTON).putExtra("b", b);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // Capa do vídeo para a notificação e a tela de bloqueio (baixada em segundo plano).
    private void loadArt(String url) {
        artUrl = url;
        art = null;
        if (url == null || url.isEmpty()) return;
        io.execute(() -> {
            Bitmap bmp = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                try (InputStream in = c.getInputStream()) { bmp = BitmapFactory.decodeStream(in); }
            } catch (Exception ignored) {}
            final Bitmap result = bmp;
            main.post(() -> {
                if (!url.equals(artUrl) || result == null || !running) return;
                art = result;
                refresh();
            });
        });
    }

    private void stopEverything() {
        if (wakeLock.isHeld()) wakeLock.release();
        if (wifiLock.isHeld()) wifiLock.release();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Arrastou o app para fora da lista de recentes: para tudo.
        stopEverything();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        session.setActive(false);
        session.release();
        io.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
