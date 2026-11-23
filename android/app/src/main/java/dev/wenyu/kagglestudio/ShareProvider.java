package dev.wenyu.kagglestudio;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Read-only, temporary app-generated media selected for sharing. */
public final class ShareProvider extends ContentProvider {
    public static final String AUTHORITY="dev.wenyu.kagglestudio.share";
    private File shared(Uri uri) throws FileNotFoundException {
        String name=uri.getLastPathSegment();
        if(!AUTHORITY.equals(uri.getAuthority()) || !("/media/"+name).equals(uri.getPath()) || name==null || !name.matches("studio-share-[a-f0-9-]{36}\\.(png|jpg|mp4|webm|txt)"))throw new FileNotFoundException();
        return new File(getContext().getCacheDir(),name);
    }
    @Override public boolean onCreate(){return true;}
    @Override public String getType(Uri uri){return uri.getPath().endsWith(".txt")?"text/plain":uri.getPath().endsWith(".mp4")?"video/mp4":uri.getPath().endsWith(".webm")?"video/webm":uri.getPath().endsWith(".png")?"image/png":"image/jpeg";}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){
        try{File file=shared(uri);String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;
            MatrixCursor cursor=new MatrixCursor(columns);Object[] row=new Object[columns.length];
            for(int i=0;i<columns.length;i++){if(OpenableColumns.DISPLAY_NAME.equals(columns[i]))row[i]=file.getName();if(OpenableColumns.SIZE.equals(columns[i]))row[i]=file.length();}
            cursor.addRow(row);return cursor;
        }catch(FileNotFoundException e){return null;}
    }
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {
        if(!"r".equals(mode))throw new FileNotFoundException();
        return ParcelFileDescriptor.open(shared(uri),ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
    @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
}
