package com.filmcam.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // 완전 네이티브 카메라 플러그인 등록 (super.onCreate 이전에 해야 한다)
    registerPlugin(FilmCameraPlugin.class);
    super.onCreate(savedInstanceState);
    // 앱 첫 실행 시 카메라 권한 요청 (WebView getUserMedia가 이 권한을 사용)
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.CAMERA }, 1);
    }
  }
}
