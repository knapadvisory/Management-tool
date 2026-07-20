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
import android.util.Log;
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

        // Create the notification channels natively so calls actually ring (the
        // system ringtone) and stand apart from message pings, and both light
        // the LED / vibrate. Channels are cached by Android, so a reinstall
        // (which clears them) is needed to change an existing channel's sound.
        setupNotificationChannels();

        // If we were launched by an incoming-call full-screen intent, wake the
        // screen and show over the lock screen so the call UI is answerable.
        handleCallLaunch(getIntent());
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
                KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (km != null) km.requestDismissKeyguard(this, null);
            }
            // The web call UI takes over now — clear the full-screen call notification.
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(TeamHubMessagingService.CALL_NOTIFICATION_ID);
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

            NotificationChannel messages = new NotificationChannel(
                "teamhub_messages", "Messages & tasks", NotificationManager.IMPORTANCE_HIGH);
            messages.setDescription("DMs, mentions and task updates");
            messages.enableLights(true);
            messages.setLightColor(accent);
            messages.enableVibration(true);
            nm.createNotificationChannel(messages);

            NotificationChannel calls = new NotificationChannel(
                "teamhub_calls", "Calls", NotificationManager.IMPORTANCE_HIGH);
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
