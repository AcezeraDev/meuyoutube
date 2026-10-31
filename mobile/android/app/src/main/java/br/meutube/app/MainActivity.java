package br.meutube.app;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.webkit.WebSettings;

import androidx.lifecycle.Lifecycle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MeuTubeMediaPlugin.class);
        // Abriu por um link do YouTube ou por "Compartilhar": a tela pega o link quando terminar de carregar.
        MeuTubeMediaPlugin.pendingLink = linkFrom(getIntent());
        super.onCreate(savedInstanceState);
        // O Capacitor liga um gerenciador de cookies para os pedidos nativos, e o Android troca o cabeçalho Cookie que
        // o app manda pelos cookies guardados nele (só os de visitante): o YouTube recebia os pedidos como sem login.
        // Sem ele, cada pedido leva exatamente o que o app manda (login só nos pedidos da conta).
        java.net.CookieHandler.setDefault(null);
        // Deixa o player começar a tocar sem esperar um toque (próximo vídeo da fila, retomar pela notificação).
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        getBridge().getWebView().getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
    }

    // ---------- links do YouTube ----------
    static String linkFrom(Intent i) {
        if (i == null) return null;
        if (Intent.ACTION_VIEW.equals(i.getAction()) && i.getData() != null) return i.getData().toString();
        if (Intent.ACTION_SEND.equals(i.getAction())) return i.getStringExtra(Intent.EXTRA_TEXT);
        return null;
    }

    // Com o app já aberto, um link novo chega por aqui (a Activity é singleTask).
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = linkFrom(intent);
        if (link != null) MeuTubeMediaPlugin.sendLink(link);
    }

    // ---------- pop-up (picture-in-picture) ----------
    private PictureInPictureParams pipParams(boolean auto) {
        MediaState s = MediaState.get();
        // O Android só aceita proporções entre 1:2,39 e 2,39:1.
        float r = Math.max(1 / 2.39f, Math.min(2.39f, s.height > 0 ? (float) s.width / s.height : 16 / 9f));
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(Math.round(r * 1000), 1000));
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(true);
        return b.build();
    }

    private boolean wantsAutoPip() {
        MediaState s = MediaState.get();
        return s.active && s.playing && s.video;
    }

    // Android 12+: entra no pop-up sozinho ao sair do app com um vídeo tocando.
    void updatePipParams() {
        if (Build.VERSION.SDK_INT < 31) return;
        runOnUiThread(() -> {
            try { setPictureInPictureParams(pipParams(wantsAutoPip())); } catch (Exception ignored) {}
        });
    }

    boolean enterPip() {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            return enterPictureInPictureMode(pipParams(wantsAutoPip()));
        } catch (Exception e) {
            return false;
        }
    }

    // Android 8 a 11: o botão "início" com vídeo tocando abre o pop-up.
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31 && wantsAutoPip()) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        MeuTubeMediaPlugin.sendPip(inPip);
        // Fechou o pop-up no "X" (o app não voltou para a frente): pausa o vídeo.
        if (!inPip && getLifecycle().getCurrentState() == Lifecycle.State.CREATED) MeuTubeMediaPlugin.sendAction("pause");
    }
}
