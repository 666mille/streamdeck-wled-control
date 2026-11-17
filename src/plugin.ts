import streamDeck, { LogLevel } from "@elgato/streamdeck";
import WebSocket from "ws";
import { WledAction } from "./actions/wled-action.js";

const PLUGIN_UUID = "com.holgermilz.wled-control";
const log = streamDeck.logger.createScope("Process");

streamDeck.logger.setLevel(LogLevel.INFO);
log.info(`Start ${PLUGIN_UUID} pid=${process.pid} ppid=${process.ppid} node=${process.version}`);

const wledAction = new WledAction();

// ---------------------------------------------------------------------------
// Sauberes Beenden
// ---------------------------------------------------------------------------
// Das Elgato-SDK (1.x) registriert weder "close" noch "error" auf seinem
// WebSocket. Wenn Stream Deck beim Herunterfahren beendet wird, laufen die
// Poll-Timer weiter und halten node20.exe am Leben, bis Windows den Prozess
// hart abschießt. Deshalb: bei Verbindungsende selbst aufräumen und beenden.
let shuttingDown = false;
function shutdown(reason: string, code = 0): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutdown: ${reason}`);
    try {
        wledAction.dispose();
    } catch (e) {
        log.error("dispose() failed", e);
    }
    // Logger schreibt synchron; kurze Gnadenfrist, dann hart raus.
    setTimeout(() => process.exit(code), 100).unref();
}

// Hook in die ws-Klasse, die das SDK intern verwendet (dieselbe Instanz im Bundle):
//  - "close"  -> Plugin beenden
//  - "error"  ohne Listener würde sonst als uncaughtException geworfen
const wsProto = (WebSocket as any).prototype;
const origEmit = wsProto.emit;
wsProto.emit = function (this: any, event: string, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) {
        log.warn("WebSocket error (no listener)", args[0]);
        return true;
    }
    if (event === "close") {
        const result = origEmit.call(this, event, ...args);
        shutdown(`WebSocket to Stream Deck closed (code=${String(args[0])})`);
        return result;
    }
    return origEmit.call(this, event, ...args);
};

// Fallback: Elternprozess (StreamDeck.exe) verschwunden?
const parentPid = process.ppid;
setInterval(() => {
    try {
        process.kill(parentPid, 0);
    } catch (e: any) {
        if (e?.code === "ESRCH") shutdown(`parent process ${parentPid} gone`);
    }
}, 2000).unref();

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(sig, () => shutdown(sig));
}

// ---------------------------------------------------------------------------
// Fehler protokollieren statt abstürzen – mit Plugin-Kennung im Log
// ---------------------------------------------------------------------------
// Das SDK registriert nur process.once("uncaughtException"): ab dem zweiten
// Fehler stirbt der Prozess. Unhandled Rejections beenden Node 20 sofort.
process.on("uncaughtException", (err) => {
    log.error(`[${PLUGIN_UUID}] uncaughtException`, err);
});
process.on("unhandledRejection", (reason) => {
    log.error(`[${PLUGIN_UUID}] unhandledRejection`, reason);
});
process.on("exit", (code) => {
    log.info(`Process exit code=${code}`);
});

// Action registrieren & verbinden
streamDeck.actions.registerAction(wledAction);
streamDeck.connect().catch((e) => log.error("connect() failed", e));
