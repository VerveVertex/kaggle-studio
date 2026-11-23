import dev.wenyu.kagglestudio.NetworkPolicy;

public class NetworkPolicyTest {
    public static void main(String[] args) throws Exception {
        for(String value:new String[]{"https://gpu.example.com/api/status", "https://llm.example.com/v1/chat/completions", "https://cdn.example.com/video.mp4?signature=abc"})
            if(NetworkPolicy.checkedUrl(value)==null)throw new AssertionError(value);
        for(String value:new String[]{"http://gpu.example.com", "https://127.0.0.1/api/status", "https://localhost/", "https://[::1]/", "https://metadata.google.internal/", "https://user:secret@example.com/", "https://example.com:8443/", "https://appassets.androidplatform.net/", "file:///tmp/data", "https://example.lan/"}) {
            boolean rejected=false;try{NetworkPolicy.checkedUrl(value);}catch(Exception expected){rejected=true;}
            if(!rejected)throw new AssertionError("Accepted forbidden URL: "+value);
        }
        if(!NetworkPolicy.allowedHeader("Authorization") || NetworkPolicy.allowedHeader("Cookie") || !NetworkPolicy.allowedMethod("DELETE") || NetworkPolicy.allowedMethod("PATCH"))throw new AssertionError("Header/method policy failed");
        System.out.println("Android network policy: public HTTPS, local URL rejection, header and method checks passed");
    }
}
