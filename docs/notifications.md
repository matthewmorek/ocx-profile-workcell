# Notifications

OpenCode V2 owns terminal titles and desktop alerts. Workcell does not add a
custom title writer, spinner, desktop notifier, global `cli.json`, or host
patch, and does not promise the former custom alert or sound policy.

The local `workcell-notify` component owns cmux status through
`files/plugins/notify/server.ts` and `files/plugins/notify/tui.ts`. cmux needs
its executable on `CLIENT`'s `PATH`, `CMUX_WORKSPACE_ID`, and
`CMUX_SURFACE_ID`. Child-only activity is not promoted to the root. The legacy
`kdco-notify.json` is not read and should be preserved rather than deleted.

After installation or profile changes, start a fresh
`ocx oc -p workcell` session; plugins are not hot reloaded. Native title,
desktop-alert, and cmux visual rendering remain runtime-dependent and are not
claimed as fully verified here.
