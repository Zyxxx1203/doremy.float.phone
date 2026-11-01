import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const manifest = read("android-shell/app/src/main/AndroidManifest.xml");
const gradle = read("android-shell/app/build.gradle");
const activity = read("android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt");

const intentionallyUnusedPermissions = [
  "android.permission.READ_CONTACTS",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_CALL_LOG",
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.BODY_SENSORS",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.NFC",
  "android.permission.EXPAND_STATUS_BAR",
];
const declared = intentionallyUnusedPermissions.filter(permission => manifest.includes(permission));
assert.deepEqual(declared, [], "Manifest must not regain unused sensitive permissions without an explicit code and privacy review.");
assert.match(manifest, /android:allowBackup="false"/, "Android automatic backup must stay disabled; use explicit in-app export.");
assert.ok(!manifest.includes('android:usesCleartextTraffic="true"'), "Cleartext must remain controlled by the restrictive network security config.");
assert.match(activity, /WebView\.setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/, "WebView debugging must be disabled in release builds.");
assert.ok(!activity.includes('addJavascriptInterface(ShellBridge(), "AndroidShell")'), "Raw ShellBridge must never be exposed to every WebView frame.");
assert.ok(!activity.includes('addJavascriptInterface(PhoneWidgetBridge(), "PhoneWidget")'), "Raw PhoneWidgetBridge must never be exposed to every WebView frame.");
assert.match(activity, /SecureJavascriptBridge\(ShellBridge\(\)\)/, "Shell bridge must use the nonce-gated dispatcher.");
assert.match(activity, /SecureJavascriptBridge\(PhoneWidgetBridge\(\)\)/, "Widget bridge must use the nonce-gated dispatcher.");
assert.match(activity, /WebViewCompat\.addDocumentStartJavaScript/, "Trusted bridge wrapper must be installed at document start.");
assert.match(activity, /nonce != bridgeNonce/, "Every native bridge invocation must validate the top-level nonce.");
assert.match(activity, /window !== window\.top/, "The bridge wrapper must not be installed inside frames.");

const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
const bridgeVersion = activity.match(/const val VERSION = "([^"]+)"/)?.[1];
const usesBuildConfigVersion = activity.includes("val VERSION: String = BuildConfig.VERSION_NAME");
assert.ok(Number.isInteger(versionCode) && versionCode > 0, "Gradle versionCode must be a positive integer.");
assert.ok(versionName, "Gradle versionName must be present.");
assert.ok(bridgeVersion === versionName || usesBuildConfigVersion, "MainActivity.VERSION must match the APK versionName or read BuildConfig.VERSION_NAME directly.");

console.log("Android permission baseline and version parity checks passed.");
