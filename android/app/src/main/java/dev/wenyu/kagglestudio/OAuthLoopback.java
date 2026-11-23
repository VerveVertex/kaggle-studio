package dev.wenyu.kagglestudio;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/** Single-use OAuth callback listener. Binds loopback only; never loads a remote page in the WebView. */
public final class OAuthLoopback implements AutoCloseable {
    private final ServerSocket server;
    private final String state, provider;
    private final long expires = System.currentTimeMillis() + 600000;
    private volatile boolean closed;
    private String code, error;
    private boolean consumed;
    public OAuthLoopback(String state, String provider) throws Exception {
        if (state == null || !state.matches("[a-f0-9]{64}") ||
            !("cloudflare".equals(provider) || "kaggle".equals(provider))) throw new IllegalArgumentException();
        this.state=state;this.provider=provider;
        server=new ServerSocket(8765,4,InetAddress.getByName("127.0.0.1"));
        server.setSoTimeout(1000);
        Thread thread=new Thread(()->listen(),"studio-oauth-loopback");thread.setDaemon(true);thread.start();
    }
    public String redirectUri(){return "http://localhost:8765/oauth/"+provider;}
    public boolean matches(String candidate){return candidate!=null && MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8),candidate.getBytes(StandardCharsets.UTF_8));}
    private void listen(){
        try{
            while(!closed && System.currentTimeMillis()<expires){
                try(Socket socket=server.accept()){
                    socket.setSoTimeout(3000);
                    InputStream input=socket.getInputStream();StringBuilder headers=new StringBuilder();
                    while(headers.length()<8192){int c=input.read();if(c<0)break;headers.append((char)c);if(headers.toString().endsWith("\r\n\r\n"))break;}
                    boolean accepted=accept(headers.toString());
                    String body=accepted?"Sign-in received. Return to Kaggle Studio.":"This sign-in callback was not accepted.";
                    String response="HTTP/1.1 "+(accepted?"200 OK":"400 Bad Request")+"\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: "+body.getBytes(StandardCharsets.UTF_8).length+"\r\n\r\n"+body;
                    OutputStream output=socket.getOutputStream();output.write(response.getBytes(StandardCharsets.UTF_8));output.flush();
                    if(accepted)break;
                }catch(SocketTimeoutException ignored){}catch(Exception ignored){}
            }
        }finally{close();}
    }
    synchronized boolean accept(String request){
        if(closed || code!=null || error!=null || System.currentTimeMillis()>=expires || request.length()>=8192 || !request.endsWith("\r\n\r\n"))return false;
        try{
            String[] lines=request.split("\r\n");String[] first=lines[0].split(" ");
            if(first.length!=3 || !first[0].equals("GET") || !first[2].equals("HTTP/1.1"))return false;
            boolean host=false;
            for(int i=1;i<lines.length;i++)if(lines[i].toLowerCase(java.util.Locale.ROOT).startsWith("host:")){
                if(host || !lines[i].substring(5).trim().equalsIgnoreCase("localhost:8765"))return false;host=true;
            }
            if(!host)return false;
            URI uri=new URI(first[1]);if(uri.isAbsolute() || uri.getRawAuthority()!=null || uri.getFragment()!=null || !uri.getPath().equals("/oauth/"+provider))return false;
            Map<String,String> args=new HashMap<>();
            if(uri.getRawQuery()==null)return false;
            for(String pair:uri.getRawQuery().split("&")){
                String[] kv=pair.split("=",2);String key=URLDecoder.decode(kv[0],"UTF-8");
                if(args.containsKey(key))return false;args.put(key,kv.length==2?URLDecoder.decode(kv[1],"UTF-8"):"");
            }
            if(!matches(args.get("state")))return false;
            String value=args.get("code");
            if(args.containsKey("error")){error="denied";return true;}
            if(value==null || value.isEmpty() || value.length()>4096 || value.matches("(?s).*[\\x00-\\x1f\\x7f].*"))return false;
            code=value;return true;
        }catch(Exception ignored){return false;}
    }
    public synchronized Map<String,String> read(String candidate){
        Map<String,String> result=new HashMap<>();
        if(!matches(candidate)){result.put("status","invalid");return result;}
        result.put("state",state);
        if(consumed){result.put("status","consumed");return result;}
        if(error!=null){result.put("status","denied");consumed=true;return result;}
        if(code!=null){result.put("status","complete");result.put("code",code);code=null;consumed=true;return result;}
        result.put("status",closed || System.currentTimeMillis()>=expires?"expired":"pending");return result;
    }
    @Override public void close(){closed=true;try{server.close();}catch(Exception ignored){}}
}
