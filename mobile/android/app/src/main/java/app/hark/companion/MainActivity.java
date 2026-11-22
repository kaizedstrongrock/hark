package app.hark.companion;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // HARK listens while it is in the background (with its foreground service running). Keep the
        // WebView's renderer at "important" priority even when it is not visible, so the system does not
        // reclaim it while the screen is off.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }
}
