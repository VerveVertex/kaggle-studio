package dev.wenyu.kagglestudio;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int PICK_IMAGE = 31, SAVE_DOCUMENT = 32, CAPTURE_IMAGE=33;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();
    private WebView web;
    private FrameLayout root;
    private volatile boolean destroyed;
    private OAuthLoopback oauthCallback;
    private volatile boolean chinese;
    private ValueCallback<Uri[]> fileCallback;
    private File pendingFile, captureFile;
    private Uri captureUri;
    private FileOutputStream exportStream;
    private String exportId, exportName, exportMime;
    private long exportedBytes;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        chinese="zh-CN".equals(getSharedPreferences("ui-preferences",MODE_PRIVATE).getString("language","en"));
        File[] stale=getCacheDir().listFiles();
        if(stale!=null)for(File f:stale)if((f.getName().startsWith("studio-export-")||f.getName().startsWith("studio-camera-")))f.delete();
        if(stale!=null)for(File f:stale)if(f.getName().startsWith("studio-share-")&&System.currentTimeMillis()-f.lastModified()>86400000L)f.delete();
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root = new FrameLayout(this);
        String appearance=getSharedPreferences("ui-preferences",MODE_PRIVATE).getString("appearance","system");
        boolean initialDark="dark".equals(appearance)||(!"light".equals(appearance)&&systemDark());
        root.setBackgroundColor(initialDark?Color.rgb(33,33,33):Color.WHITE);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v,insets) -> {
                Insets bar=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard=insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bar.left,bar.top,bar.right,Math.max(bar.bottom,keyboard.bottom));
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setTextZoom(100);
        if(Build.VERSION.SDK_INT>=29)settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        WebView.setWebContentsDebuggingEnabled(false);
        web.addJavascriptInterface(new NativeApi(), "StudioNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri=request.getUrl();
                if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost()))
                    return empty(403,"Blocked");
                String path=uri.getPath();
                if(path==null || path.equals("/"))path="/index.html";
                if(path.contains("..") || path.contains("\\") || !request.getMethod().equals("GET"))return empty(404,"Not found");
                String mime=path.endsWith(".html")?"text/html":path.endsWith(".js")?"text/javascript":
                    path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":
                    path.endsWith(".woff2")?"font/woff2":path.endsWith(".woff")?"font/woff":path.endsWith(".ttf")?"font/ttf":
                    path.endsWith(".webmanifest")?"application/manifest+json":path.endsWith(".txt")?"text/plain":"application/octet-stream";
                try {
                    Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");
                    headers.put("X-Content-Type-Options","nosniff");
                    return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open("site"+path));
                }catch(Exception ex){return empty(404,"Not found");}
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri=request.getUrl();
                if("https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()))return false;
                if(request.isForMainFrame())openExternalUrl(uri.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if(fileCallback!=null)fileCallback.onReceiveValue(null);
                fileCallback=callback;
                cleanCapture();
                if(params.isCaptureEnabled()){
                    try{
                        captureFile=new File(getCacheDir(),"studio-camera-"+UUID.randomUUID().toString()+".jpg");captureFile.createNewFile();
                        captureUri=Uri.parse("content://"+CameraProvider.AUTHORITY+"/photo/"+captureFile.getName());
                        Intent camera=new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                        camera.putExtra(android.provider.MediaStore.EXTRA_OUTPUT,captureUri);
                        camera.setClipData(ClipData.newRawUri("Studio photo",captureUri));
                        camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivityForResult(camera,CAPTURE_IMAGE);
                    }catch(Exception ex){fileCallback.onReceiveValue(null);fileCallback=null;cleanCapture();Toast.makeText(MainActivity.this,localized("Camera unavailable. Try attaching a photo.","无法打开相机，请尝试选择照片。"),Toast.LENGTH_SHORT).show();}
                    return true;
                }
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/png","image/jpeg","image/webp"});
                try{startActivityForResult(intent,PICK_IMAGE);}catch(Exception ex){fileCallback.onReceiveValue(null);fileCallback=null;}
                return true;
            }
        });
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0,()->handleBack());
        web.loadUrl(ORIGIN+"/");
        applyTheme(initialDark);
    }

    private WebResourceResponse empty(int code,String message) {
        return new WebResourceResponse("text/plain","UTF-8",code,message,new HashMap<>(),new ByteArrayInputStream(new byte[0]));
    }
    private void openExternalUrl(String raw) {
        try {
            URL url=NetworkPolicy.checkedUrl(raw);
            ui.post(()->{try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url.toString())));}catch(Exception ex){Toast.makeText(this,localized("No browser is available.","没有可用的浏览器。"),Toast.LENGTH_SHORT).show();}});
        }catch(Exception ignored){}
    }
    private boolean systemDark(){return (getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;}
    private void notifySystemTheme(){if(web!=null&&!destroyed)web.evaluateJavascript("window.dispatchEvent(new Event('studio-system-theme'));",null);}
    @Override public void onConfigurationChanged(Configuration next){super.onConfigurationChanged(next);notifySystemTheme();}
    private String localized(String en,String zh){return chinese?zh:en;}
    private void applyTheme(boolean dark) {
        int color=dark?Color.rgb(33,33,33):Color.WHITE;
        getSharedPreferences("ui-preferences",MODE_PRIVATE).edit().putBoolean("dark",dark).apply();
        root.setBackgroundColor(color);getWindow().getDecorView().setBackgroundColor(color);
        if(Build.VERSION.SDK_INT>=29){getWindow().setStatusBarContrastEnforced(false);getWindow().setNavigationBarContrastEnforced(false);}
        getWindow().setStatusBarColor(color);getWindow().setNavigationBarColor(color);
        web.setBackgroundColor(color);
        int flags=View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if(!dark)flags|=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }
    private void handleBack() {
        web.evaluateJavascript("window.__studioBack?window.__studioBack():false",value->{
            if(!"true".equals(value)){if(web.canGoBack())web.goBack();else moveTaskToBack(true);}
        });
    }
    @Override public void onBackPressed(){handleBack();}

    private static class Call {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        volatile Future<?> future;
        void cancel(){cancelled=true;if(connection!=null)connection.disconnect();if(future!=null)future.cancel(true);}
    }
    private void emit(JSONObject event) {
        String script="window.__studioNetwork&&window.__studioNetwork("+event.toString()+");";
        ui.post(()->{if(!destroyed)web.evaluateJavascript(script,null);});
    }
    private void event(String id,String type,String key,Object value) {
        try{JSONObject event=new JSONObject().put("id",id).put("type",type);if(key!=null)event.put(key,value);emit(event);}catch(Exception ignored){}
    }
    private void performRequest(String id,String payload,Call call) {
        try {
            if(call.cancelled)return;
            JSONObject request=new JSONObject(payload);
            URL url=NetworkPolicy.checkedUrl(request.getString("url"));
            String method=request.optString("method","GET");
            if(!NetworkPolicy.allowedMethod(method))throw new IllegalArgumentException("Unsupported request method.");
            HttpURLConnection connection=(HttpURLConnection)url.openConnection();
            call.connection=connection;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);connection.setReadTimeout(url.getPath().endsWith("/chat/completions")?1800000:180000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("User-Agent","KaggleStudioAndroid/0.3.0");
            JSONObject headers=request.optJSONObject("headers");
            if(headers!=null){Iterator<String> keys=headers.keys();while(keys.hasNext()){
                String key=keys.next();if(NetworkPolicy.allowedHeader(key))connection.setRequestProperty(key,headers.getString(key));
            }}
            if(method.equals("POST") || method.equals("PUT")) {
                byte[] body=Base64.decode(request.optString("body",""),Base64.DEFAULT);
                if(body.length>18*1024*1024)throw new IllegalArgumentException("Request exceeds 18 MB.");
                connection.setDoOutput(true);connection.setFixedLengthStreamingMode(body.length);
                try(OutputStream output=connection.getOutputStream()){output.write(body);}
            }
            if(call.cancelled)return;
            int status=connection.getResponseCode();
            if(status<200 || status>599)throw new IllegalStateException();
            JSONObject responseHeaders=new JSONObject();
            String contentType=connection.getContentType();
            responseHeaders.put("content-type",contentType==null?"application/octet-stream":contentType);
            emit(new JSONObject().put("id",id).put("type","headers").put("status",status).put("headers",responseHeaders));
            InputStream input=status>=400?connection.getErrorStream():connection.getInputStream();
            if(input!=null)try(InputStream stream=input){
                byte[] buffer=new byte[8192];int count;long total=0;
                while(!call.cancelled && (count=stream.read(buffer))!=-1){
                    total+=count;if(total>256L*1024*1024)throw new IllegalArgumentException("Response exceeds 256 MB.");
                    event(id,"chunk","data",Base64.encodeToString(buffer,0,count,Base64.NO_WRAP));
                }
            }
            if(!call.cancelled)event(id,"end",null,null);
        }catch(IllegalArgumentException ex){if(!call.cancelled)event(id,"error","message","Use a public HTTPS service and a supported request size.");}
        catch(java.net.SocketTimeoutException ex){if(!call.cancelled)event(id,"error","message","The service timed out while processing the input. Use background tasks or reduce conversation history.");}
        catch(javax.net.ssl.SSLException ex){if(!call.cancelled)event(id,"error","message","HTTPS certificate or secure connection failed. Check the service hostname and certificate.");}
        catch(java.net.UnknownHostException ex){if(!call.cancelled)event(id,"error","message","The service hostname could not be resolved. Check DNS and connectivity.");}
        catch(Exception ex){if(!call.cancelled)event(id,"error","message","The connection was interrupted. The model may still be processing. Check Compute before sending again.");}
        finally{if(call.connection!=null)call.connection.disconnect();calls.remove(id,call);}
    }

    private SecretKey vaultKey() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        String alias="kaggle-studio-service-keys";
        if(!store.containsAlias(alias)) {
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey(alias,null);
    }
    private synchronized String loadVault() {
        try {
            String encrypted=getSharedPreferences("vault",MODE_PRIVATE).getString("encrypted",null);
            if(encrypted==null)return "{}";
            JSONObject value=new JSONObject(encrypted);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,vaultKey(),new GCMParameterSpec(128,Base64.decode(value.getString("iv"),Base64.DEFAULT)));
            cipher.updateAAD(getPackageName().getBytes("UTF-8"));
            return new String(cipher.doFinal(Base64.decode(value.getString("data"),Base64.DEFAULT)),"UTF-8");
        }catch(Exception ex){return "{}";}
    }
    private synchronized boolean storeVault(String raw) {
        try {
            if(raw.length()>16384)return false;
            JSONObject input=new JSONObject(raw),clean=new JSONObject();boolean present=false;
            for(String key:new String[]{"modelKey","managerKey","imageKey","videoKey"}) {
                String value=input.optString(key,"");clean.put(key,value);if(!value.isEmpty())present=true;
            }
            SharedPreferences.Editor edit=getSharedPreferences("vault",MODE_PRIVATE).edit();
            if(!present){return edit.remove("encrypted").commit();}
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,vaultKey());
            cipher.updateAAD(getPackageName().getBytes("UTF-8"));
            JSONObject value=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP))
                .put("data",Base64.encodeToString(cipher.doFinal(clean.toString().getBytes("UTF-8")),Base64.NO_WRAP));
            return edit.putString("encrypted",value.toString()).commit();
        }catch(Exception ex){return false;}
    }

    private synchronized String loadSetupVault() {
        try {
            String raw=getSharedPreferences("setup-vault",MODE_PRIVATE).getString("encrypted",null);if(raw==null)return "{}";
            JSONObject value=new JSONObject(raw);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,vaultKey(),new GCMParameterSpec(128,Base64.decode(value.getString("iv"),Base64.DEFAULT)));
            cipher.updateAAD((getPackageName()+"/setup-v1").getBytes("UTF-8"));
            return new String(cipher.doFinal(Base64.decode(value.getString("data"),Base64.DEFAULT)),"UTF-8");
        }catch(Exception ex){return "{\"storage_error\":true}";}
    }
    private synchronized boolean saveSetupVault(String raw) {
        try {
            if(raw==null || raw.length()>131072)return false;JSONObject parsed=new JSONObject(raw);
            SharedPreferences.Editor edit=getSharedPreferences("setup-vault",MODE_PRIVATE).edit();
            if(parsed.length()==0)return edit.remove("encrypted").commit();
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,vaultKey());
            cipher.updateAAD((getPackageName()+"/setup-v1").getBytes("UTF-8"));
            JSONObject value=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP))
                .put("data",Base64.encodeToString(cipher.doFinal(raw.getBytes("UTF-8")),Base64.NO_WRAP));
            return edit.putString("encrypted",value.toString()).commit();
        }catch(Exception ex){return false;}
    }

    public class NativeApi {
        @JavascriptInterface public void request(String id,String payload) {
            if(destroyed || id==null || !id.matches("http-[0-9]{1,12}") || payload==null)return;
            if(payload.length()>26*1024*1024 || calls.size()>=8){event(id,"error","message","Too many requests or request too large.");return;}
            Call call=new Call();if(calls.putIfAbsent(id,call)!=null)return;
            call.future=pool.submit(()->performRequest(id,payload,call));
        }
        @JavascriptInterface public void cancel(String id){Call call=calls.remove(id);if(call!=null)call.cancel();}
        @JavascriptInterface public String readKeys(){return loadVault();}
        @JavascriptInterface public String readSetup(){return loadSetupVault();}
        @JavascriptInterface public boolean saveSetup(String raw){return saveSetupVault(raw);}
        @JavascriptInterface public synchronized String beginOAuthCallback(String state,String provider){
            try{if(oauthCallback!=null)oauthCallback.close();oauthCallback=new OAuthLoopback(state,provider);
                return new JSONObject().put("redirect_uri",oauthCallback.redirectUri()).toString();
            }catch(Exception ex){return "{\"error\":\"callback_unavailable\"}";}
        }
        @JavascriptInterface public synchronized String readOAuthCallback(String state){
            return oauthCallback==null?"{\"status\":\"expired\"}":new JSONObject(oauthCallback.read(state)).toString();
        }
        @JavascriptInterface public synchronized void cancelOAuthCallback(String state){
            if(oauthCallback!=null && oauthCallback.matches(state)){oauthCallback.close();oauthCallback=null;}
        }
        @JavascriptInterface public boolean saveKeys(String keys){return storeVault(keys);}
        @JavascriptInterface public void copy(String text){if(text!=null && text.length()<2*1024*1024)ui.post(()->{
            ClipboardManager clipboard=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);clipboard.setPrimaryClip(ClipData.newPlainText("Studio",text));
        });}
        @JavascriptInterface public void shareText(String text){if(text==null)return;ui.post(()->{try{Intent share=new Intent(Intent.ACTION_SEND).setType("text/plain");byte[] bytes=text.getBytes("UTF-8");if(bytes.length>200000){File file=new File(getCacheDir(),"studio-share-"+UUID.randomUUID()+".txt");try(FileOutputStream out=new FileOutputStream(file)){out.write(bytes);}Uri uri=Uri.parse("content://"+ShareProvider.AUTHORITY+"/media/"+file.getName());share.putExtra(Intent.EXTRA_STREAM,uri);share.setClipData(ClipData.newRawUri("Studio message",uri));share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);}else share.putExtra(Intent.EXTRA_TEXT,text);startActivity(Intent.createChooser(share,localized("Share message","分享消息")));}catch(Exception ex){Toast.makeText(MainActivity.this,localized("Sharing is unavailable.","无法打开分享。"),Toast.LENGTH_SHORT).show();}});}
        @JavascriptInterface public void setLanguage(String language){
            chinese="zh-CN".equals(language);
            getSharedPreferences("ui-preferences",MODE_PRIVATE).edit().putString("language",chinese?"zh-CN":"en").apply();
        }
        @JavascriptInterface public boolean isSystemDark(){return systemDark();}
        @JavascriptInterface public void setThemeMode(String mode){if("light".equals(mode)||"dark".equals(mode)||"system".equals(mode))getSharedPreferences("ui-preferences",MODE_PRIVATE).edit().putString("appearance",mode).apply();}
        @JavascriptInterface public void setTheme(boolean dark){ui.post(()->{if(!destroyed)applyTheme(dark);});}
        @JavascriptInterface public void openExternal(String raw){openExternalUrl(raw);}
        @JavascriptInterface public synchronized String beginFile(String name,String mime){
            if(exportId!=null)return "";
            try {
                exportId=UUID.randomUUID().toString();exportName=name==null?"studio-export":name.replaceAll("[^a-zA-Z0-9._ -]","_");
                if(exportName.length()>120)exportName=exportName.substring(0,120);
                exportMime=mime!=null && mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")?mime:"application/octet-stream";
                pendingFile=File.createTempFile("studio-export-",".tmp",getCacheDir());exportStream=new FileOutputStream(pendingFile);exportedBytes=0;
                return exportId;
            }catch(Exception ex){cleanExport();return "";}
        }
        @JavascriptInterface public synchronized boolean appendFile(String id,String encoded){
            if(exportId==null || !exportId.equals(id) || exportStream==null || encoded.length()>100000)return false;
            try {
                byte[] data=Base64.decode(encoded,Base64.DEFAULT);exportedBytes+=data.length;
                if(exportedBytes>256L*1024*1024){cleanExport();return false;}
                exportStream.write(data);return true;
            }catch(Exception ex){cleanExport();return false;}
        }
        @JavascriptInterface public void finishCapture(String name){ui.post(()->{if(captureFile!=null&&captureFile.getName().equals(name))cleanCapture();});}
        @JavascriptInterface public synchronized void cancelFile(String id){if(exportId!=null && exportId.equals(id))cleanExport();}
        @JavascriptInterface public synchronized boolean finishShareFile(String id){
            if(exportId==null||!exportId.equals(id)||exportStream==null)return false;
            String ext=exportMime.equals("image/png")?"png":exportMime.equals("image/jpeg")?"jpg":exportMime.equals("video/mp4")?"mp4":exportMime.equals("video/webm")?"webm":null;
            if(ext==null){cleanExport();return false;}
            try{exportStream.close();exportStream=null;File shared=new File(getCacheDir(),"studio-share-"+UUID.randomUUID()+"."+ext);if(!pendingFile.renameTo(shared)){cleanExport();return false;}String mime=exportMime;pendingFile=null;exportId=null;
                Uri uri=Uri.parse("content://"+ShareProvider.AUTHORITY+"/media/"+shared.getName());
                ui.post(()->{try{Intent share=new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri);share.setClipData(ClipData.newRawUri("Studio media",uri));share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(share,localized("Share media","分享媒体")));}catch(Exception ex){shared.delete();Toast.makeText(MainActivity.this,localized("Sharing unavailable.","无法分享。"),Toast.LENGTH_SHORT).show();}});return true;
            }catch(Exception ex){cleanExport();return false;}
        }
        @JavascriptInterface public synchronized void finishFile(String id){
            if(exportId==null || !exportId.equals(id) || exportStream==null)return;
            try{exportStream.close();exportStream=null;}catch(Exception ex){cleanExport();return;}
            ui.post(()->{
                try{Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(exportMime).putExtra(Intent.EXTRA_TITLE,exportName);startActivityForResult(intent,SAVE_DOCUMENT);}
                catch(Exception ex){cleanExport();Toast.makeText(MainActivity.this,localized("File export is unavailable.","无法导出文件。"),Toast.LENGTH_SHORT).show();}
            });
        }
    }
    private void cleanCapture(){
        if(captureUri!=null)revokeUriPermission(captureUri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if(captureFile!=null)captureFile.delete();captureFile=null;captureUri=null;
    }
    private synchronized void cleanExport(){
        try{if(exportStream!=null)exportStream.close();}catch(Exception ignored){}
        if(pendingFile!=null)pendingFile.delete();pendingFile=null;exportStream=null;exportId=null;
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==CAPTURE_IMAGE){
            boolean okay=result==RESULT_OK&&captureFile!=null&&captureFile.length()>0;
            if(fileCallback!=null){fileCallback.onReceiveValue(okay?new Uri[]{captureUri}:null);fileCallback=null;}
            if(!okay)cleanCapture();
        }
        if(request==PICK_IMAGE){if(fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK && data!=null && data.getData()!=null?new Uri[]{data.getData()}:null);fileCallback=null;}}
        if(request==SAVE_DOCUMENT){
            if(result!=RESULT_OK || data==null || data.getData()==null || pendingFile==null){cleanExport();return;}
            Uri destination=data.getData();File source=pendingFile;
            pool.submit(()->{
                try(InputStream input=new FileInputStream(source);OutputStream output=getContentResolver().openOutputStream(destination)){
                    if(output==null)throw new IllegalStateException();byte[] buffer=new byte[32768];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);
                    ui.post(()->Toast.makeText(this,localized("File saved.","文件已保存。"),Toast.LENGTH_SHORT).show());
                }catch(Exception ex){ui.post(()->Toast.makeText(this,localized("The file could not be saved.","无法保存文件。"),Toast.LENGTH_SHORT).show());}
                finally{cleanExport();}
            });
        }
    }
    @Override protected void onPause(){super.onPause();if(web!=null)web.onPause();}
    @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();notifySystemTheme();}
    @Override protected void onDestroy(){
        destroyed=true;if(oauthCallback!=null)oauthCallback.close();for(Call call:calls.values())call.cancel();calls.clear();pool.shutdownNow();cleanExport();cleanCapture();
        if(fileCallback!=null)fileCallback.onReceiveValue(null);
        if(web!=null){web.removeJavascriptInterface("StudioNative");web.destroy();}
        super.onDestroy();
    }
}
