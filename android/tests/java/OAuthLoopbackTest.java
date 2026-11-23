package dev.wenyu.kagglestudio;
import java.net.Socket;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
public class OAuthLoopbackTest {
 static String send(String target,String host,String method) throws Exception {
  try(Socket s=new Socket("127.0.0.1",8765)){
   s.setSoTimeout(3000);s.getOutputStream().write((method+" "+target+" HTTP/1.1\r\nHost: "+host+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
   InputStream input=s.getInputStream();StringBuilder text=new StringBuilder();int c;while((c=input.read())!=-1)text.append((char)c);return text.toString();
  }
 }
 public static void main(String[] args) throws Exception {
  String state=new String(new char[64]).replace('\0','a');
  try(OAuthLoopback callback=new OAuthLoopback(state,"kaggle")){
   String valid="/oauth/kaggle?state="+state+"&code=private-test-code";
   for(String invalid:new String[]{"/oauth/kaggle?state=wrong&code=x","/oauth/cloudflare?state="+state+"&code=x",valid+"&state="+state,"https://evil.example"+valid})
    if(!send(invalid,"localhost:8765","GET").startsWith("HTTP/1.1 400"))throw new AssertionError("Accepted invalid callback");
   if(!send(valid,"evil.example","GET").startsWith("HTTP/1.1 400"))throw new AssertionError("Host check");
   if(!send(valid,"localhost:8765","POST").startsWith("HTTP/1.1 400"))throw new AssertionError("Method check");
   if(!"pending".equals(callback.read(state).get("status")))throw new AssertionError("Invalid response consumed state");
   String response=send(valid,"localhost:8765","GET");if(!response.startsWith("HTTP/1.1 200")||response.contains("private-test-code"))throw new AssertionError("Response reflected authorization code");
   if(!"invalid".equals(callback.read("other").get("status")))throw new AssertionError("Wrong state read");
   Map<String,String> result=callback.read(state);if(!"complete".equals(result.get("status"))||!"private-test-code".equals(result.get("code")))throw new AssertionError("Missing callback");
   if(!"consumed".equals(callback.read(state).get("status")))throw new AssertionError("Callback replay");
  }
  System.out.println("OAuth loopback: live socket, Host/path/state/method checks, no reflection and one-use callback passed");
 }
}
