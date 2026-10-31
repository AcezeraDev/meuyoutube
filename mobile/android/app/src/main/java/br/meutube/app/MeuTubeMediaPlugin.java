package br.meutube.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import android.app.AppOpsManager;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Process;
import android.view.WindowManager;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

// Recebe da tela o que está tocando (título, canal, capa, tocando ou não, se é vídeo) e devolve para ela os
// botões apertados na notificação/tela de bloqueio/fone ("action") e a entrada e saída do pop-up ("pip").
@CapacitorPlugin(name = "MeuTubeMedia")
public class MeuTubeMediaPlugin extends Plugin {
    static MeuTubeMediaPlugin instance;
    static String pendingLink; // link do YouTube que abriu o app, esperando a tela pedir
    private boolean askedNotifications = false;

    @Override
    public void load() {
        instance = this;
    }

    static void sendAction(String action) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        instance.notifyListeners("action", data);
    }

    static void sendLink(String url) {
        if (instance == null) { pendingLink = url; return; }
        JSObject data = new JSObject();
        data.put("url", url);
        instance.notifyListeners("link", data);
    }

    @PluginMethod
    public void takeLink(PluginCall call) {
        JSObject r = new JSObject();
        r.put("url", pendingLink == null ? "" : pendingLink);
        pendingLink = null;
        call.resolve(r);
    }

    static void sendPip(boolean active) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("active", active);
        instance.notifyListeners("pip", data);
    }

    @PluginMethod
    public void update(PluginCall call) {
        MediaState s = MediaState.get();
        s.title = call.getString("title", "MeuTube");
        s.artist = call.getString("artist", "");
        s.artwork = call.getString("artwork", "");
        s.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        s.video = Boolean.TRUE.equals(call.getBoolean("video", false));
        s.width = call.getInt("width", 16);
        s.height = call.getInt("height", 9);
        s.canNext = Boolean.TRUE.equals(call.getBoolean("canNext", false));
        s.active = true;

        // Android 13+: a notificação com os controles precisa de permissão (pede uma vez, quando começa a tocar).
        if (s.playing && !askedNotifications && Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askedNotifications = true;
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7001);
        }

        Intent i = new Intent(getContext(), MediaService.class).setAction(MediaService.ACTION_UPDATE);
        if (MediaService.running) getContext().startService(i);
        else if (s.playing) ContextCompat.startForegroundService(getContext(), i); // só liga quando algo toca

        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).updatePipParams();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MediaState.get().active = false;
        MediaState.get().playing = false;
        if (MediaService.running) getContext().startService(new Intent(getContext(), MediaService.class).setAction(MediaService.ACTION_STOP));
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).updatePipParams();
        call.resolve();
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        MediaState s = MediaState.get();
        s.width = call.getInt("width", s.width);
        s.height = call.getInt("height", s.height);
        getActivity().runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT < 26 || !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                call.reject("Este celular não tem pop-up de vídeo.");
                return;
            }
            // Pop-up desligado para o MeuTube nas configurações do Android: abre a tela certa para ligar.
            if (!pipAllowed()) {
                try {
                    getActivity().startActivity(new Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS", Uri.parse("package:" + getContext().getPackageName())));
                } catch (Exception ignored) {}
                call.reject("O pop-up está desligado para o MeuTube. Ligue “Picture-in-picture” na tela que abriu.");
                return;
            }
            boolean ok = getActivity() instanceof MainActivity && ((MainActivity) getActivity()).enterPip();
            if (ok) call.resolve();
            else call.reject("O Android não abriu o pop-up agora. Tente de novo com o vídeo tocando.");
        });
    }

    private boolean pipAllowed() {
        try {
            AppOpsManager ops = (AppOpsManager) getContext().getSystemService(android.content.Context.APP_OPS_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), getContext().getPackageName())
                    : ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), getContext().getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return true;
        }
    }

    // ---------- tela cheia ----------
    // O Capacitor cancela a tela cheia pedida pela página; esta é a do próprio app: esconde as barras do Android,
    // gira para deitado (vídeos deitados) e faz o botão voltar sair da tela cheia em vez de sair do vídeo.
    private OnBackPressedCallback fsBack;

    @PluginMethod
    public void setFullscreen(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", true));
        getActivity().runOnUiThread(() -> {
            android.app.Activity a = getActivity();
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
            if (on) {
                bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                bars.hide(WindowInsetsCompat.Type.systemBars());
                a.setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (fsBack == null && a instanceof androidx.activity.ComponentActivity) {
                    fsBack = new OnBackPressedCallback(true) {
                        @Override public void handleOnBackPressed() { sendAction("exit-fullscreen"); }
                    };
                    ((androidx.activity.ComponentActivity) a).getOnBackPressedDispatcher().addCallback(fsBack);
                }
            } else {
                bars.show(WindowInsetsCompat.Type.systemBars());
                a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (fsBack != null) { fsBack.remove(); fsBack = null; }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void exitPip(PluginCall call) {
        // Sair do pop-up é trazer o app para a frente.
        Intent i = new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // Endereço do mini-servidor que entrega os vídeos ao player (veja MediaProxy).
    @PluginMethod
    public void mediaProxy(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("base", MediaProxy.get().base());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Não consegui ligar o servidor de vídeo do app.");
        }
    }

    // "Entrar com Google": abre a página de login do Google e devolve os cookies do YouTube (texto do cookies.txt).
    @PluginMethod
    public void googleLogin(PluginCall call) {
        startActivityForResult(call, new Intent(getContext(), GoogleLoginActivity.class), "googleLoginDone");
    }

    @ActivityCallback
    private void googleLoginDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        String cookies = data != null ? data.getStringExtra(GoogleLoginActivity.EXTRA_COOKIES) : null;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || cookies == null) {
            call.reject("Login cancelado.");
            return;
        }
        JSObject r = new JSObject();
        r.put("cookies", cookies);
        call.resolve(r);
    }
}
