# HARK companion app (Android and iOS)

The phone and tablet app is the HARK web app (`../public`) inside a [Capacitor](https://capacitorjs.com) shell.
The screens, sound recognition and alert logic are the same files the computers use. The app adds what a
web page cannot do reliably on a phone:

| | Android | iOS (iPhone, iPad) |
|---|---|---|
| Listens with the microphone (on the device, never recorded) | yes | yes |
| Keeps listening with the app in the background / screen off | yes: foreground service with a "HARK is listening" notification | no: iOS pauses web-view microphones in the background, so keep HARK open (it keeps the screen on while listening) |
| Vibration patterns (one per sound, urgent ones repeat until "I've seen it") | yes (haptics) | yes (haptics; iOS buzzes are fixed-length, so a pattern becomes a series of buzzes) |
| Notifications | yes, "Urgent alerts" channel at the highest importance | yes |
| Joins the home network by itself on the home Wi-Fi | yes | yes (asks once for local network access) |
| `hark://join?...` links | yes | yes |

Away from home the app keeps listening and alerting on its own. Back on the home Wi-Fi it reconnects to the
home hubs by itself, within about 8 seconds (sooner when the phone reports a network change).

## Build

You need Node.js 20+, and:
- **Android:** Android Studio (or JDK 21 and the Android SDK, platform 36).
- **iOS:** a Mac with Xcode 16 or newer.

```bash
cd mobile
npm install
npm run android      # copies ../public into www/, syncs, opens Android Studio
npm run ios          # same for Xcode
```

Command-line Android build (debug APK in `android/app/build/outputs/apk/debug/`):

```bash
npm run build:android
```

After changing anything in `../public`, run `npm run sync` (or one of the commands above) so the native
projects get the new files.

## Connecting the app to the home

1. On the computer that runs the hub (`npm start` in the project folder), open HARK and go to **Devices**.
2. In the app, go to **Devices** and type the **home code** and the **address** shown on the computer.

Or open a `hark://join?h=<home code>&hub=http://<address>/` link on the phone. The QR code on the computer
opens the web version in the phone's browser, which can show alerts but cannot listen: browsers only allow
the microphone on secure (https) pages, and a home hub serves plain http.

## What is configured where

- `capacitor.config.json`: app id `app.hark.companion`, web files from `www/` (copied from `../public` by
  `scripts/copy-web.mjs`), mixed content allowed on Android so the app (https://localhost) can reach hubs at
  http://192.168.x.x.
- `android/app/src/main/AndroidManifest.xml`: microphone, notification, vibration, wake-lock and
  foreground-service (microphone type) permissions; the foreground service; `hark://join` links.
- `android/app/src/main/res/xml/network_security_config.xml`: plain http to home hubs.
- `android/app/src/main/java/app/hark/companion/MainActivity.java`: keeps the web view's renderer at high
  priority while listening in the background.
- `ios/App/App/Info.plist`: microphone and local-network permission texts, local networking over http
  (`NSAllowsLocalNetworking`), `hark://` links.
- Native plugins: `@capacitor/app`, `@capacitor/haptics`, `@capacitor/local-notifications`,
  `@capacitor/network`, `@capacitor-community/keep-awake`,
  `@capawesome-team/capacitor-android-foreground-service` (all MIT). The web app talks to them through
  `public/js/platform.js` and falls back to web APIs in a browser.

## Status

- Android: the debug app builds with Gradle (`npm run build:android`). It has not yet been tried on a real
  phone; check microphone permission, background listening with the screen off, vibration and joining
  the home hub on a device before relying on it.
- iOS: the Xcode project is generated and configured, but it has not been built (that needs a Mac).
