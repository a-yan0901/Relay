package cn.ayan.relay;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(RelayNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onBackPressed() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            super.onBackPressed();
            return;
        }
        getBridge().getWebView().evaluateJavascript(
            "(function(){var event=new Event('relay:back',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()",
            handled -> {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        );
    }
}
