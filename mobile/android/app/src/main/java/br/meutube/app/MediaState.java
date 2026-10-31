package br.meutube.app;

// O que está tocando agora, compartilhado entre o plugin, o serviço da notificação e a Activity (pop-up).
final class MediaState {
    private static final MediaState INSTANCE = new MediaState();

    static MediaState get() {
        return INSTANCE;
    }

    String title = "MeuTube";
    String artist = "";
    String artwork = "";
    boolean playing = false;
    boolean video = false;
    boolean canNext = false;
    boolean active = false;
    int width = 16;
    int height = 9;
}
