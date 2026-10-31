# MeuTube

Um YouTube próprio, sem anúncios, que roda no seu computador. Tem busca, canais, lives com chat, comentários (com curtir e responder), conta do YouTube, playlists, downloads em MP4/MP3, SponsorBlock, "não gostei" estimado e mais.

## Como rodar

Precisa de:

- [Node.js](https://nodejs.org) 22 ou mais novo
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) no PATH
- [ffmpeg](https://ffmpeg.org) no PATH (para os downloads)

Depois:

```bash
node server.js
```

e abra http://localhost:3000. No Windows, `iniciar.bat` faz as duas coisas.

Para abrir no celular pela rede de casa, use `HOST=0.0.0.0 node server.js`.

## Gerador de tokens (opcional, recomendado)

A pasta `pot-provider` é o [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) (licença GPL-3.0). Com ele o YouTube bloqueia bem menos. O servidor liga o gerador sozinho se ele estiver compilado:

```bash
cd pot-provider/server
npm ci
npx tsc
```

## Privacidade

O login do YouTube (`cookies.txt`, `config.json` e a pasta `login-profile`) fica só no seu computador e está no `.gitignore`.
