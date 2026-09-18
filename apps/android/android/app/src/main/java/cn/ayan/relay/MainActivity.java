package cn.ayan.relay;

import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(RelayNativePlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchRelayBack(this);
            }
        });
    }

    private void dispatchRelayBack(OnBackPressedCallback callback) {
        if (getBridge() == null || getBridge().getWebView() == null) {
            callback.setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
            callback.setEnabled(true);
            return;
        }
        getBridge().getWebView().evaluateJavascript(
            "(function(){var event=new Event('relay:back',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()",
            handled -> {
                if (!"true".equals(handled)) {
                    callback.setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    callback.setEnabled(true);
                }
            }
        );
    }
}
