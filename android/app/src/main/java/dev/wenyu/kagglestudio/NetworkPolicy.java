package dev.wenyu.kagglestudio;

import java.net.URI;
import java.net.URL;
import java.util.Locale;

public final class NetworkPolicy {
    private NetworkPolicy() {}
    public static URL checkedUrl(String raw) throws Exception {
        URI uri = new URI(raw);
        String host = uri.getHost();
        if (host == null) throw new IllegalArgumentException("A public HTTPS service is required.");
        host = host.toLowerCase(Locale.ROOT);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null ||
            (uri.getPort() != -1 && uri.getPort() != 443) || uri.getFragment() != null ||
            host.indexOf('.') < 0 || host.indexOf(':') >= 0 || host.matches("[0-9.]+") ||
            host.equals("localhost") || host.equals("metadata.google.internal") ||
            host.matches(".*\\.(localhost|local|internal|test|lan)$") ||
            host.equals("appassets.androidplatform.net")) {
            throw new IllegalArgumentException("A public HTTPS service is required.");
        }
        return uri.toURL();
    }
    public static boolean allowedMethod(String method) {
        return method.equals("GET") || method.equals("POST") || method.equals("HEAD") || method.equals("PUT") || method.equals("DELETE");
    }
    public static boolean allowedHeader(String name) {
        return name.equalsIgnoreCase("Authorization") || name.equalsIgnoreCase("Content-Type") || name.equalsIgnoreCase("Accept");
    }
}
