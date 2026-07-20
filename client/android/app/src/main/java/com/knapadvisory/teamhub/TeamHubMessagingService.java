package com.knapadvisory.teamhub;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Extends the Capacitor push service. Incoming *calls* are turned into a
 * full-screen-intent notification so the phone lights up and shows the app
 * over the lock screen (like a normal phone/WhatsApp call); everything else
 * (DMs, task updates) is handled by the Capacitor plugin as before.
 */
public class TeamHubMessagingService extends MessagingService {
    private static final String TAG = "TeamHub";
    static final int CALL_NOTIFICATION_ID = 4243;

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data != null && "call".equals(data.get("type"))) {
            try {
                showIncomingCall(data);
            } catch (Throwable t) {
                Log.e(TAG, "full-screen call notification failed", t);
            }
            return; // handled — don't also run the default path
        }
        super.onMessageReceived(remoteMessage);
    }

    private void showIncomingCall(Map<String, String> data) {
        String title = data.get("title") != null ? data.get("title") : "Incoming call";
        String body = data.get("body") != null ? data.get("body") : "";

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("teamhub_incoming_call", "1");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 100, open, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, "teamhub_calls")
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body.isEmpty() ? "Tap to answer" : body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setOngoing(true)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true);

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(CALL_NOTIFICATION_ID, b.build());
    }
}
