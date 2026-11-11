# Space for iOS and Android

A Capacitor shell that loads the Space web app from its server, like Space Desktop does. Every web feature works, and sign-in uses the web app's own cookies.

## Run on the iOS simulator

Start the backend and `pnpm web`, then from the repo root:

```sh
pnpm --filter @space/capacitor ios
```

Pick a simulator when asked. Run this in your own terminal: Swift Package Manager needs its own sandbox.

## Point it at another server

`SPACE_URL` is read when the native projects sync. The default is `http://127.0.0.1:5173/chat`.

```sh
env SPACE_URL=https://space.example.com/chat pnpm --filter @space/capacitor ios
```

The address must be the server's `BETTER_AUTH_URL` origin or listed in `AUTH_TRUSTED_ORIGINS`. For a real phone on your Wi-Fi, use your Mac's LAN address, add it to `AUTH_TRUSTED_ORIGINS`, and start the web dev server with `--host 0.0.0.0`.

## Android

Install Android Studio and its SDK, then run `pnpm --filter @space/capacitor android`. The emulator reaches the host at `10.0.2.2`.

## Limits

- Plain `http` is for development only. Release builds need `https`.
- Capacitor marks loading a remote `server.url` as meant for development. App Store review can reject apps that only show a website. Shipping to the stores needs native value such as push notifications, or bundling the web build with server changes for cross-origin sign-in.
