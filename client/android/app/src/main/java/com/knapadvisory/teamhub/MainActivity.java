package com.knapadvisory.teamhub;

import android.Manifest;
import android.app.AlertDialog;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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
