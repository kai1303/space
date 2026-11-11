# Space mobile

Expo app for iOS and Android. Design: `docs/superpowers/specs/2026-11-11-mobile-app-design.md`.

## Configure

Create `apps/mobile/.env.local` with the server origin the device can reach:

```
EXPO_PUBLIC_SPACE_URL=http://127.0.0.1:3000
```

The value must be the server's `BETTER_AUTH_URL` origin or be listed in `AUTH_TRUSTED_ORIGINS`. Otherwise writes fail with `403 untrusted_origin`. The Android emulator reaches the host at `10.0.2.2`, so use `http://10.0.2.2:3000` and add it to `AUTH_TRUSTED_ORIGINS`. Release builds require `https://`.

## Run

```
pnpm mobile          # from the repo root, then open in Expo Go
pnpm --filter @space/mobile test
pnpm --filter @space/mobile typecheck
```
