import { Plugin } from "@opencode/plugin";

// The conventional sibling tui.ts is advertised by the native directory
// loader. No effects run in the daemon; terminal identity belongs to the client.
export default Plugin.define({ id: "workcell-notify", setup() {} });
