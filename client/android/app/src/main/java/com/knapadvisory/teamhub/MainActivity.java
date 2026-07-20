package com.knapadvisory.teamhub;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "TeamHub";
    private static final String CRASH_FILE = "last_crash.txt";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Persist any uncaught crash so we can show the reason on the next
        // launch, instead of the app silently closing with no clue why.
        installCrashHandler();

        super.onCreate(savedInstanceState);

        // If the previous run died, surface the stack trace so it can be
        // screenshotted and reported (then clear it).
        maybeShowLastCrash();

        // Ask for the permissions calls need — but only after the WebView and
        // bridge are up, and guarded, so a permission hiccup on any ROM can
        // never take down launch (this used to run inline in onCreate).
        new Handler(Looper.getMainLooper()).post(this::requestCallPermissions);

        // Let the app actually download files. A WebView can't download on its
        // own — route any download the page triggers to Android's DownloadManager
        // (saves to the Downloads folder with a progress notification).
        new Handler(Looper.getMainLooper()).post(this::setupDownloads);

        // Expose a tiny native bridge so the in-app Settings screen can open
        // Android's per-channel sound pickers (change the call ringtone / the
        // message notification tone) — those live in the OS, not the web app.
        new Handler(Looper.getMainLooper()).post(this::setupNativeBridge);

        // Create the notification channels natively so calls actually ring (the
        // system ringtone) and stand apart from message pings, and both light
        // the LED / vibrate. Channels are cached by Android, so a reinstall
        // (which clears them) is needed to change an existing channel's sound.
        setupNotificationChannels();

        // If we were launched by an incoming-call full-screen intent, wake the
        // screen and show over the lock screen so the call UI is answerable.
        handleCallLaunch(getIntent());

        // A short delay lets the runtime-permission dialog resolve first, then
        // we nudge (once) to enable full-screen calls if Android is blocking them.
        new Handler(Looper.getMainLooper()).postDelayed(this::maybePromptFullScreenPermission, 2500);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallLaunch(intent);
    }

    private void handleCallLaunch(Intent intent) {
        try {
            if (intent == null || !intent.hasExtra("teamhub_incoming_call")) return;
            // Modern API: show over the lock screen and turn the screen on.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
                KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (km != null) km.requestDismissKeyguard(this, null);
            }
            // Belt-and-braces: legacy window flags also wake the display and show
            // over the keyguard, covering ROMs where the setters aren't honoured.
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
            // NOTE: we deliberately do NOT cancel the call notification here.
            // Cancelling it the instant the activity opens cut the ringtone off
            // before it was audible. The web call UI cancels it (via the bridge)
            // once the call is answered or declined.
        } catch (Throwable t) {
            Log.e(TAG, "call launch handling failed", t);
        }
    }

    private void setupNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            int accent = Color.parseColor("#4F46E5");

            // Remove the earlier calls channel: its sound is locked to whatever
            // it was first created with (often a plain notification tone), so we
            // drop it and create a fresh versioned channel with the ringtone.
            try { nm.deleteNotificationChannel("teamhub_calls"); } catch (Throwable ignored) { }

            NotificationChannel messages = new NotificationChannel(
                TeamHubMessagingService.MESSAGES_CHANNEL_ID, "Messages & tasks", NotificationManager.IMPORTANCE_HIGH);
            messages.setDescription("DMs, mentions and task updates");
            messages.enableLights(true);
            messages.setLightColor(accent);
            messages.enableVibration(true);
            nm.createNotificationChannel(messages);

            NotificationChannel calls = new NotificationChannel(
                TeamHubMessagingService.CALL_CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Incoming audio and video calls");
            calls.enableLights(true);
            calls.setLightColor(accent);
            calls.enableVibration(true);
            calls.setVibrationPattern(new long[]{0, 600, 400, 600, 400, 600});
            Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            calls.setSound(ringtone, attrs);
            nm.createNotificationChannel(calls);
        } catch (Throwable t) {
            Log.e(TAG, "notification channel setup failed", t);
        }
    }

    private void setupDownloads() {
        try {
            android.webkit.WebView webView = getBridge().getWebView();
            if (webView == null) return;
            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
                try {
                    String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    request.setMimeType(mimeType);
                    if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                    request.setTitle(name);
                    request.setDescription("Downloading…");
                    request.allowScanningByMediaScanner();
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(request);
                    Toast.makeText(getApplicationContext(), "Downloading " + name, Toast.LENGTH_SHORT).show();
                } catch (Throwable t) {
                    Log.e(TAG, "download failed", t);
                    Toast.makeText(getApplicationContext(), "Couldn't download the file", Toast.LENGTH_SHORT).show();
                }
            });
        } catch (Throwable t) {
            Log.e(TAG, "download listener setup failed", t);
        }
    }

    private boolean hasFullScreenIntentPermission() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                return nm != null && nm.canUseFullScreenIntent();
            }
            return true;
        } catch (Throwable t) {
            return true;
        }
    }

    private void launchFullScreenIntentSettings() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                    .setData(Uri.parse("package:" + getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else {
                startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
        } catch (Throwable t) {
            Log.e(TAG, "open full-screen-intent settings failed", t);
        }
    }

    // On Android 14+, nudge the user once to allow full-screen call alerts if
    // the permission is missing — otherwise incoming calls can't wake the
    // screen. "Don't remind me" is remembered so we never nag.
    private void maybePromptFullScreenPermission() {
        try {
            if (hasFullScreenIntentPermission()) return;
            android.content.SharedPreferences sp = getSharedPreferences("teamhub", MODE_PRIVATE);
            if (sp.getBoolean("fsi_prompt_dismissed", false)) return;
            new AlertDialog.Builder(this)
                .setTitle("Turn on full-screen calls")
                .setMessage("So incoming calls ring and light up your screen like a normal phone call, allow full-screen notifications for TeamHub.")
                .setPositiveButton("Allow", (d, w) -> launchFullScreenIntentSettings())
                .setNegativeButton("Not now", null)
                .setNeutralButton("Don't remind me", (d, w) -> sp.edit().putBoolean("fsi_prompt_dismissed", true).apply())
                .show();
        } catch (Throwable t) {
            Log.e(TAG, "full-screen prompt failed", t);
        }
    }

    private void setupNativeBridge() {
        try {
            android.webkit.WebView webView = getBridge().getWebView();
            if (webView == null) return;
            webView.addJavascriptInterface(new NativeBridge(), "TeamHubNative");
            // Let the web ring/answer play audio without a user gesture (needed
            // for the in-call ringtone and remote audio to start on their own).
            webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        } catch (Throwable t) {
            Log.e(TAG, "native bridge setup failed", t);
        }
    }

    /**
     * Small JS-callable bridge. The web Settings page checks for
     * window.TeamHubNative and, on Android, offers buttons that jump straight
     * to the system sound picker for our notification channels.
     */
    public class NativeBridge {
        // True when the OS will actually let a full-screen intent launch the
        // call screen. Auto-granted pre-Android-14; on 14+ the user must allow
        // it, so the web Settings surfaces a button when this is false.
        @JavascriptInterface
        public boolean canUseFullScreenIntent() { return hasFullScreenIntentPermission(); }

        // Send the user to the OS screen where full-screen call alerts are
        // allowed for this app (Android 14+), falling back to app notifications.
        @JavascriptInterface
        public void openFullScreenIntentSettings() { runOnUiThread(() -> launchFullScreenIntentSettings()); }

        // Stop the ringing call notification once the web UI has taken over
        // (call answered, declined or ended).
        @JavascriptInterface
        public void cancelIncomingCall() {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(TeamHubMessagingService.CALL_NOTIFICATION_ID);
            } catch (Throwable t) {
                Log.e(TAG, "cancel incoming call failed", t);
            }
        }

        @JavascriptInterface
        public void openCallSoundSettings() { openChannelSettings(TeamHubMessagingService.CALL_CHANNEL_ID); }

        @JavascriptInterface
        public void openMessageSoundSettings() { openChannelSettings(TeamHubMessagingService.MESSAGES_CHANNEL_ID); }

        @JavascriptInterface
        public void openChannelSettings(String channelId) {
            runOnUiThread(() -> {
                try {
                    Intent intent;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && channelId != null && !channelId.isEmpty()) {
                        intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                            .putExtra(Settings.EXTRA_CHANNEL_ID, channelId);
                    } else {
                        intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    }
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Throwable t) {
                    Log.e(TAG, "open channel settings failed", t);
                    try {
                        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Throwable ignored) { }
                }
            });
        }
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> {
            try {
                Log.e(TAG, "Uncaught exception", ex);
                StringWriter sw = new StringWriter();
                ex.printStackTrace(new PrintWriter(sw));
                FileWriter fw = new FileWriter(new File(getFilesDir(), CRASH_FILE), false);
                fw.write(sw.toString());
                fw.close();
            } catch (Throwable ignored) {
                // Never let the crash handler itself throw.
            }
            if (prev != null) prev.uncaughtException(thread, ex);
        });
    }

    private void maybeShowLastCrash() {
        try {
            File f = new File(getFilesDir(), CRASH_FILE);
            if (!f.exists()) return;
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new FileReader(f));
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            r.close();
            f.delete();
            final String msg = sb.toString();
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    new AlertDialog.Builder(this)
                        .setTitle("TeamHub closed unexpectedly last time")
                        .setMessage("Please screenshot this and send it to your admin:\n\n" + msg)
                        .setPositiveButton("OK", null)
                        .show();
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private void requestCallPermissions() {
        try {
            java.util.ArrayList<String> perms = new java.util.ArrayList<>();
            perms.add(Manifest.permission.CAMERA);
            perms.add(Manifest.permission.RECORD_AUDIO);
            perms.add(Manifest.permission.MODIFY_AUDIO_SETTINGS);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                perms.add(Manifest.permission.POST_NOTIFICATIONS);
            }
            ActivityCompat.requestPermissions(this, perms.toArray(new String[0]), 100);
        } catch (Throwable t) {
            Log.e(TAG, "permission request failed", t);
        }
    }
}
