// The modernize live status canvas for the GitHub Copilot app. Declares the `modernize-status`
// canvas and follows the session's activity for it. This is the only file that imports the SDK;
// everything it uses is a plain module beside it. Nothing here writes to stdout, which carries
// the JSON-RPC connection.
// The canvas readers are adapted from anthropics/claude-plugins-official
// plugins/code-modernization/hooks/reader (Apache-2.0); see NOTICE.
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { canvasOptions } from "./canvas.mjs";
import { createHub } from "./hub.mjs";
import { ACTIVITY_EVENTS } from "./activity.mjs";
import os from "node:os";

// Copilot may start this process inside the plugin folder. Windows cannot delete or rename a
// folder that is a process's working directory, so an open session would block plugin updates
// and uninstall ("os error 32"). Nothing here needs a working directory: move out of it.
try {
    process.chdir(os.tmpdir());
} catch {
    // keep the directory we were given
}

const hub = createHub();

const session = await joinSession({ canvases: [createCanvas(canvasOptions(hub))] });

for (const type of ACTIVITY_EVENTS) {
    try {
        session.on(type, (event) => {
            try {
                hub.event(event);
            } catch {
                // a malformed event must never take the session's extension down
            }
        });
    } catch {
        // an event this Copilot version does not know: the page simply shows less activity
    }
}
