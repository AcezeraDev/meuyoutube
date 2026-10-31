package br.meutube.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
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
            boolean ok = getActivity() instanceof MainActivity && ((MainActivity) getActivity()).enterPip();
            if (ok) call.resolve();
            else call.reject("Este aparelho não tem pop-up de vídeo.");
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
