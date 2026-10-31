package br.meutube.app;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Os arquivos de vídeo do YouTube (googlevideo.com) só respondem a pedidos de até ~5 MB por vez; o player do
// Android pede "do byte X até o fim" e levava 403. Aqui o app pede o pedaço ao YouTube no tamanho aceito e entrega
// ao player como resposta parcial (206); o player pede o resto sozinho, pedaço por pedaço (o servidor do PC faz igual).
public class MediaWebViewClient extends BridgeWebViewClient {
    private static final long CHUNK = 4L * 1024 * 1024;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d+)-(\\d*)");

    public MediaWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String host = u.getHost() == null ? "" : u.getHost();
        // Só os arquivos de vídeo/áudio (têm "clen", o tamanho total); as lives (HLS) seguem direto.
        if ("GET".equals(request.getMethod()) && host.endsWith(".googlevideo.com") && u.getQueryParameter("clen") != null) {
            WebResourceResponse r = fetchChunk(u, request.getRequestHeaders());
            if (r != null) return r;
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse fetchChunk(Uri u, Map<String, String> headers) {
        long total;
        try {
            total = Long.parseLong(u.getQueryParameter("clen"));
        } catch (NumberFormatException e) {
            return null;
        }
        long start = 0, end = total - 1;
        String range = null;
        for (Map.Entry<String, String> h : headers.entrySet()) if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
        if (range != null) {
            Matcher m = RANGE.matcher(range);
            if (m.find()) {
                start = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) end = Math.min(end, Long.parseLong(m.group(2)));
            }
        }
        end = Math.min(end, start + CHUNK - 1);
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u.toString()).openConnection();
            c.setRequestProperty("Range", "bytes=" + start + "-" + end);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            int status = c.getResponseCode();
            String type = c.getContentType() == null ? "application/octet-stream" : c.getContentType().split(";")[0];
            Map<String, String> out = new HashMap<>();
            out.put("Accept-Ranges", "bytes");
            out.put("Access-Control-Allow-Origin", "*");
            out.put("Cache-Control", "no-store");
            if (status == 206 || status == 200) {
                long len = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : end - start + 1;
                out.put("Content-Range", "bytes " + start + "-" + (start + len - 1) + "/" + total);
                out.put("Content-Length", String.valueOf(len));
                InputStream in = c.getInputStream();
                return new WebResourceResponse(type, null, 206, "Partial Content", out, in);
            }
            // Link vencido ou recusado: repassa o erro, e o player pede links novos.
            return new WebResourceResponse("text/plain", null, status, status == 403 ? "Forbidden" : "Error", out, c.getErrorStream());
        } catch (Exception e) {
            return null;
        }
    }
}
