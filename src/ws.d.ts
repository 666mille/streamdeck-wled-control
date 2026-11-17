// Minimal-Deklaration: "ws" wird nur für den Close/Error-Hook in plugin.ts gebraucht.
declare module "ws" {
    const WebSocket: any;
    export default WebSocket;
}
