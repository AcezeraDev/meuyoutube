package br.meutube.app;

import android.net.Uri;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Mini-servidor dentro do celular (só 127.0.0.1, ninguém de fora acessa) que entrega os vídeos do YouTube ao player.
// O YouTube só aceita pedidos de até ~5 MB por vez e o player pede "do byte X até o fim"; aqui cada pedido vira um
// pedaço de 4 MB (resposta 206) e o player pede o próximo sozinho. É o mesmo que o /media do servidor do PC faz.
final class MediaProxy {
    private static final long CHUNK = 4L * 1024 * 1024;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d+)-(\\d*)");
    private static MediaProxy instance;

    final int port;
    final String token;
    private final ServerSocket server;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    static synchronized MediaProxy get() throws Exception {
        if (instance == null) instance = new MediaProxy();
        return instance;
    }

    private MediaProxy() throws Exception {
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        byte[] b = new byte[12];
        new SecureRandom().nextBytes(b);
        StringBuilder t = new StringBuilder();
        for (byte x : b) t.append(String.format("%02x", x));
        token = t.toString();
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (Exception ignored) {}
            }
        }, "MeuTube-media");
        accept.setDaemon(true);
        accept.start();
    }

    String base() {
        return "http://127.0.0.1:" + port + "/" + token + "/m?u=";
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.ISO_8859_1));
            String first = in.readLine();
            if (first == null) return;
            String range = null;
            for (String line; (line = in.readLine()) != null && !line.isEmpty(); ) {
                int c = line.indexOf(':');
                if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase("range")) range = line.substring(c + 1).trim();
            }
            String[] parts = first.split(" ");
            OutputStream out = sock.getOutputStream();
            if (parts.length < 2 || !(parts[0].equals("GET") || parts[0].equals("HEAD")) || !parts[1].startsWith("/" + token + "/m?")) {
                write(out, "404 Not Found", "text/plain", null, 0);
                return;
            }
            String target = Uri.parse("http://x" + parts[1]).getQueryParameter("u");
            Uri u = target == null ? null : Uri.parse(target);
            String host = u == null || u.getHost() == null ? "" : u.getHost();
            if (target == null || !target.startsWith("https://") || !host.endsWith(".googlevideo.com")) {
                write(out, "400 Bad Request", "text/plain", null, 0);
                return;
            }
            String mime = u.getQueryParameter("mime");
            long total = -1;
            try { total = Long.parseLong(u.getQueryParameter("clen")); } catch (Exception ignored) {}

            long start = 0, end = total > 0 ? total - 1 : Long.MAX_VALUE;
            if (range != null) {
                Matcher m = RANGE.matcher(range);
                if (m.find()) {
                    start = Long.parseLong(m.group(1));
                    if (!m.group(2).isEmpty()) end = Math.min(end, Long.parseLong(m.group(2)));
                }
            }
            if (total > 0 && start >= total) {
                write(out, "416 Range Not Satisfiable", "text/plain", "Content-Range: bytes */" + total + "\r\n", 0);
                return;
            }
            end = Math.min(end, start + CHUNK - 1);

            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setRequestProperty("Range", "bytes=" + start + "-" + end);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            int status = c.getResponseCode();
            if (status != 200 && status != 206) {
                // Link vencido ou recusado: repassa o erro, e o player pede links novos.
                write(out, status + " Upstream", "text/plain", null, 0);
                return;
            }
            long len = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : end - start + 1;
            String type = mime != null && !mime.isEmpty() ? mime : (c.getContentType() == null ? "application/octet-stream" : c.getContentType());
            String extra = "Content-Range: bytes " + start + "-" + (start + len - 1) + "/" + (total > 0 ? total : "*") + "\r\n";
            write(out, "206 Partial Content", type, extra, len);
            if (parts[0].equals("HEAD")) return;
            try (InputStream up = c.getInputStream()) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = up.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            out.flush();
        } catch (Exception ignored) {
            // O player cancelou (trocou de qualidade, pulou o vídeo...) ou a rede caiu: ele pede de novo se precisar.
        }
    }

    private static void write(OutputStream out, String status, String type, String extra, long len) throws Exception {
        String h = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + len + "\r\n"
                + "Accept-Ranges: bytes\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + (extra == null ? "" : extra)
                + "\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }
}
