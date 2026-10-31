package br.meutube.app;

import android.app.PictureInPictureParams;
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
        super.onCreate(savedInstanceState);
        // Deixa o player começar a tocar sem esperar um toque (próximo vídeo da fila, retomar pela notificação).
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        getBridge().getWebView().getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
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
