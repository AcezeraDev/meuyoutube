package br.meutube.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// "Entrar com Google" no celular: abre a página oficial de login do Google dentro do app. Quando o YouTube aparece
// já logado, lê só os cookies do youtube.com (o app nunca vê a senha) e devolve no formato do cookies.txt.
public class GoogleLoginActivity extends Activity {
    static final String EXTRA_COOKIES = "cookies";
    private static final String LOGIN_URL = "https://accounts.google.com/ServiceLogin?service=youtube&hl=pt-BR&passive=true"
            + "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Dm%26next%3Dhttps%253A%252F%252Fm.youtube.com%252F";
    private WebView web;
    private boolean done = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        web = new WebView(this);
        cm.setAcceptThirdPartyCookies(web, true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Sem a marca "wv" o Google trata a página como o navegador do celular.
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/[\\d.]+ ", ""));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) { check(url); }

            @Override
            public void onPageFinished(WebView view, String url) { check(url); }
        });
        setContentView(web);
        web.loadUrl(LOGIN_URL);
    }

    private void check(String url) {
        if (done || url == null || !url.matches("https://(www\\.|m\\.)?youtube\\.com/.*")) return;
        String raw = CookieManager.getInstance().getCookie("https://www.youtube.com");
        if (raw == null || !raw.contains("SAPISID=")) return;
        done = true;
        StringBuilder txt = new StringBuilder("# Netscape HTTP Cookie File\n");
        for (String part : raw.split(";\\s*")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            txt.append(".youtube.com\tTRUE\t/\tTRUE\t0\t").append(part.substring(0, eq)).append('\t').append(part.substring(eq + 1)).append('\n');
        }
        // Tira os cookies do armazenamento do Android: o app guarda a cópia dele e manda o login só quando precisa
        // (os links de vídeo são pedidos sem conta). Isso não sai da conta no Google.
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        setResult(RESULT_OK, new Intent().putExtra(EXTRA_COOKIES, txt.toString()));
        finish();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
