# Offline browser lifecycle gate

Run `npm run test:browser:lifecycle` in an independent verification copy with
the existing root/frontend dependencies. An installed Chrome/Chromium and a
Node version with `WebSocket` are required; set `CHROME_PATH` when Chrome is
not in the platform's default location. No browser or dependency is downloaded.
This optional gate is not part of `verify:all`, so CI does not silently skip it
or acquire a browser dependency.

The runner bundles the real `useSilentSync` and `useDataTransfer` hooks, mounts React in Chromium,
and checks 13 scenarios: disabled sync/StrictMode, independent accounts,
hidden/visible continuation, logout, unmount/remount, bounded cooldown, and
failure of the current HTTP stream, a 51-account cross-page pool (global ≤25),
migration preview/separate confirmation/single-flight, changed-key invalidation,
unknown commit without replay, late file-read fencing, and logout/secret clearing.
Visibility events, sessions and API
responses are synthetic. This is not a real-provider, background-tab OS
throttling, server-crash, or cloud-runtime acceptance test.

It serves a loopback-only fixture, disallows connections through CSP, blocks
non-fixture target requests through CDP, and uses a fresh isolated browser
profile. It never opens the real database, logs in, or resumes Scanner. These
are test guards, not an operating-system network sandbox. Only the spawned
browser is closed; the user's browser and other project processes are untouched.
The browser profile and `receipt.json` are retained under the approved OpenCode
temp directory on Windows, or the system temp directory elsewhere.
