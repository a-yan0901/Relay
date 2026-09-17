package cn.ayan.relay;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(RelayNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
