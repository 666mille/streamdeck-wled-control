import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type DialDownEvent,
  type DialRotateEvent,
  type TouchTapEvent,
  type SendToPluginEvent,
  type JsonObject,
  LogLevel,
} from "@elgato/streamdeck";
import { Buffer } from "node:buffer";
import * as os from "node:os"; 

// TYPES
type ControlMode = "BRIGHTNESS" | "EFFECT" | "PRESET" | "PALETTE" | "RELAY";

interface MultiRelayData {
    relays: { relay: number; state: boolean }[];
}

interface WledState {
  on: boolean; bri: number; ps: number; pl: number;
  seg: { fx: number; sx: number; ix: number; pal: number }[];
  MultiRelay?: MultiRelayData;
}

type WledSettings = JsonObject & {
  ipAddress?: string;
  mode?: ControlMode;
  foundDevices?: {ip: string, name: string}[]; 
  showOfflineColor?: boolean;
  offlineColor?: string;
  showRelay?: boolean;
  relayId?: string; 
  hasMultiRelay?: boolean; 
  relayCount?: number;
};

interface ContextCache {
  effects: string[]; palettes: string[]; presets: { id: number; name: string }[];
  state: WledState | null; 
  ip: string | null;
  currentMode: ControlMode; infoName: string; 
  lastError: string | null;
  isConnectionError: boolean;
  action: any; 
  settings: WledSettings;
  lastBri: number; 
  lastValidPreset: number;
  pollTimer: NodeJS.Timeout | null;
  selectionActive: boolean;
  pendingMode: ControlMode;
  hasRelayUsermod: boolean; 
  relayState: boolean; 
  lastToggleTime: number;
}

const log = streamDeck.logger.createScope("WledAction");

@action({ UUID: "com.holgermilz.wled-control.wleddial" })
export class WledAction extends SingletonAction<WledSettings> {
  private cache = new Map<string, ContextCache>();
  private selectModeTimeouts = new Map<string, NodeJS.Timeout>();

  // TURBO NETWORK SCANNER
  override async onSendToPlugin(ev: SendToPluginEvent<WledSettings, JsonObject>): Promise<void> {
    const payload = ev.payload as any;
    if (payload.event === "startScan") {
        const subnets = this.getLocalSubnets();
        subnets.sort((a, b) => {
             const prio = ["192.168.178", "192.168.1", "192.168.0"];
             const aPrio = prio.includes(a) ? 0 : 1;
             const bPrio = prio.includes(b) ? 0 : 1;
             return aPrio - bPrio;
        });
        const devices = await this.scanSubnets(subnets);
        const contextId = ev.action.id;
        const cached = this.cache.get(contextId);
        if (cached) {
            const newSettings: WledSettings = { ...cached.settings, foundDevices: devices };
            await ev.action.setSettings(newSettings);
            cached.settings = newSettings;
        }
    }
  }

  // HELPER
  private getLocalSubnets(): string[] {
      const interfaces = os.networkInterfaces();
      const subnets: string[] = [];
      for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name] || []) {
              if (iface.family === 'IPv4' && !iface.internal) {
                  const parts = iface.address.split('.');
                  parts.pop(); subnets.push(parts.join('.'));
              }
          }
      }
      return subnets;
  }

  private async scanSubnets(subnets: string[]): Promise<{ip: string, name: string}[]> {
      let candidates: string[] = [];
      candidates.push("wled.local");
      candidates.push("wled-light.local");
      for (const subnet of subnets) {
          for(let i=1; i<255; i++) candidates.push(`${subnet}.${i}`);
      }
      const foundDevices: {ip: string, name: string}[] = [];
      const batchSize = 256;
      for (let i = 0; i < candidates.length; i += batchSize) {
          const batch = candidates.slice(i, i + batchSize);
          const results = await Promise.all(batch.map(ip => this.checkWledIp(ip)));
          results.forEach(dev => {
              if (dev && !foundDevices.some(d => d.ip === dev.ip)) foundDevices.push(dev);
          });
      }
      return foundDevices;
    }

  private async checkWledIp(ip: string): Promise<{ip: string, name: string} | null> {
    try {
        const res = await this.fetchWithTimeout(`http://${ip}/json/info`, {}, 1500); 
        if (res.ok) {
            const data = (await res.json()) as any;
            return { ip: ip, name: data.name || "Unknown WLED" };
        }
    } catch (e) { }
    return null;
  }

  // STANDARD LOGIC
  private cleanIp(ip: string | undefined | null): string | null {
    if (!ip) return null;
    let clean = ip.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/[^\x20-\x7E]/g, ''); 
    if (clean.length < 4) return "INVALID_IP";
    const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    const hostnameRegex = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$|^wled(-[0-9]+)?$|^wled\.local$/;
    if (!ipv4Regex.test(clean) && !hostnameRegex.test(clean)) return "INVALID_IP";
    return clean || null;
  }

  private async fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 2500): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } catch (e: any) {
        if (e.name === 'AbortError') throw new Error("Timeout");
        throw e;
    } finally { clearTimeout(id); }
  }

  // SELECTION TIMEOUT HELPER
  private clearSelectTimeout(context: string) {
      if (this.selectModeTimeouts.has(context)) {
          clearTimeout(this.selectModeTimeouts.get(context));
          this.selectModeTimeouts.delete(context);
      }
  }

  private startSelectTimeout(actionObj: any, context: string) {
      this.clearSelectTimeout(context);
      const t = setTimeout(() => {
          const c = this.cache.get(context);
          if (c && c.selectionActive) {
              c.selectionActive = false; 
              c.pendingMode = c.currentMode;
              this.updateDisplay(actionObj, context);
          }
      }, 3000); 
      this.selectModeTimeouts.set(context, t);
  }

  override onWillAppear(ev: WillAppearEvent<WledSettings>): void {
    const s = ev.payload.settings; 
    const ip = this.cleanIp(s.ipAddress);
    const valid = (ip && ip !== "INVALID_IP") ? ip : null;

    if (!this.cache.has(ev.action.id)) {
      this.cache.set(ev.action.id, {
        effects: [], palettes: [], presets: [], 
        state: null, 
        ip: valid, 
        currentMode: s.mode || "BRIGHTNESS", 
        infoName: "WLED",
        isConnectionError: !valid,
        lastError: valid ? null : "Setup Req.", 
        action: ev.action, 
        settings: s,
        lastBri: 128,
        lastValidPreset: 0,
        pollTimer: null,
        selectionActive: false,
        pendingMode: s.mode || "BRIGHTNESS",
        hasRelayUsermod: false,
        relayState: false,
        lastToggleTime: 0 // Init
      });
    } else {
        const c = this.cache.get(ev.action.id)!; 
        c.ip = valid; 
        c.action = ev.action; 
        c.settings = s;
        if (!valid) {
            c.isConnectionError = true;
            c.lastError = "Setup Req.";
        }
    }

    const c = this.cache.get(ev.action.id)!;
    if(c.ip) {
        this.startPolling(ev.action.id);
    } else {
        this.updateDisplay(ev.action, ev.action.id);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<WledSettings>): void {
    const c = this.cache.get(ev.action.id);
    if (c && c.pollTimer) {
        clearTimeout(c.pollTimer);
        c.pollTimer = null;
    }
    this.clearSelectTimeout(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<WledSettings>): void {
    const s = ev.payload.settings; 
    const ip = this.cleanIp(s.ipAddress);
    const valid = (ip && ip !== "INVALID_IP") ? ip : null;
    
    const c = this.cache.get(ev.action.id);
    if(c) { 
        c.ip = valid; 
        c.action = ev.action; 
        c.settings = s; 
        if(s.mode) c.currentMode = s.mode; 
        
        if (valid) {
            if (c.pollTimer) clearTimeout(c.pollTimer);
            this.startPolling(ev.action.id);
        } else {
            c.isConnectionError = true;
            c.lastError = "Setup Req.";
            this.updateDisplay(ev.action, ev.action.id);
        }
    }
  }

  // DIAL PRESS = MENU / CONFIRM
  override async onDialDown(ev: DialDownEvent<WledSettings>): Promise<void> {
      const c = this.cache.get(ev.action.id);
      if (!c) return;

      if (c.selectionActive) {
          this.clearSelectTimeout(ev.action.id);
          c.selectionActive = false;
          c.currentMode = c.pendingMode;
          ev.action.setSettings({ ...c.settings, mode: c.currentMode });
          this.updateDisplay(ev.action, ev.action.id);
      } else {
          c.selectionActive = true;
          c.pendingMode = c.currentMode; 
          this.startSelectTimeout(ev.action, ev.action.id);
          this.updateDisplay(ev.action, ev.action.id);
      }
  }

  // TOUCH TAP 
  override async onTouchTap(ev: TouchTapEvent<WledSettings>): Promise<void> { 
    this.togglePower(ev.action, ev.action.id);
  }

  override async onDialRotate(ev: DialRotateEvent<WledSettings>): Promise<void> {
    const c = this.cache.get(ev.action.id); 
    if (!c || !c.ip) return;
    const ticks = ev.payload.ticks;
    
    // Menu
    if (c.selectionActive) {
        this.cyclePendingMode(c, ticks);
        this.startSelectTimeout(ev.action, ev.action.id);
        this.updateDisplay(ev.action, ev.action.id);
        return;
    }

    // Normal operation
    switch (c.currentMode) {
        case "BRIGHTNESS": this.changeBrightness(ev.action, c, ticks); break;
        case "EFFECT": this.changeEffect(ev.action, c, ticks); break;
        case "PRESET": this.changePreset(ev.action, c, ticks); break;
        case "PALETTE": this.changePalette(ev.action, c, ticks); break;
        case "RELAY": this.changeRelay(ev.action, c, ticks); break; 
    }
  }

  private cyclePendingMode(c: ContextCache, ticks: number) {
      const m: ControlMode[] = ["BRIGHTNESS", "EFFECT", "PRESET", "PALETTE"];
      if (c.settings.showRelay) m.push("RELAY");

      let idx = m.indexOf(c.pendingMode); 
      if (idx === -1) idx = 0;
      
      if (ticks > 0) { idx++; if (idx >= m.length) idx = 0; } 
      else { idx--; if (idx < 0) idx = m.length - 1; }
      
      c.pendingMode = m[idx];
  }

  // ROBUST POLLING
  private startPolling(contextId: string) {
    const c = this.cache.get(contextId);
    if (!c || !c.ip) return;

    if (c.pollTimer) clearTimeout(c.pollTimer);

    const pollLoop = async () => {
        const currentC = this.cache.get(contextId);
        if (!currentC || !currentC.ip) return;

        try {
            await this.fetchAll(contextId, currentC.ip);
        } catch (e) { }
        
        currentC.pollTimer = setTimeout(pollLoop, 3000);
    };
    pollLoop();
  }

  private async fetchAll(context: string, ip: string) {
    const c = this.cache.get(context); if(!c) return;
    try {
      const res = await this.fetchWithTimeout(`http://${ip}/json`, {}, 3000); 
      if(!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as any;
      
      if(data.state) {
          c.state = data.state;
          if (c.state && c.state.ps > 0) c.lastValidPreset = c.state.ps;
          
          let relayCount = 0;
          if (c.state && c.state.MultiRelay && Array.isArray(c.state.MultiRelay.relays)) {
              c.hasRelayUsermod = true;
              relayCount = c.state.MultiRelay.relays.length;
              
              const targetId = parseInt(c.settings.relayId || "0");
              const relayObj = c.state.MultiRelay.relays.find((r: any) => r.relay === targetId);
              if (relayObj) {
                  c.relayState = relayObj.state;
              } else {
                  c.relayState = false;
              }
          } else {
              c.hasRelayUsermod = false;
              relayCount = 0;
          }

          if (c.settings.relayCount !== relayCount || c.settings.hasMultiRelay !== c.hasRelayUsermod) {
              const newSettings = { ...c.settings, hasMultiRelay: c.hasRelayUsermod, relayCount: relayCount };
              if (c.action && c.action.setSettings) {
                  c.action.setSettings(newSettings);
              }
              c.settings = newSettings;
          }
      } 

      if(data.info) c.infoName = data.info.name;
      if(Array.isArray(data.effects)) c.effects = data.effects;
      if(Array.isArray(data.palettes)) c.palettes = data.palettes;
      try {
         const r2 = await this.fetchWithTimeout(`http://${ip}/presets.json`, {}, 2000);
         if(r2.ok) this.parsePresets(c, await r2.json());
      } catch(e) {}
      
      c.isConnectionError = false; 
      c.lastError = null;
      if (c.action) this.updateDisplay(c.action, context);

    } catch (e: unknown) { 
        c.isConnectionError = true; 
        c.lastError = "Offline";
        if (c.action) this.updateDisplay(c.action, context); 
    }
  }

  private async fetchState(id: string, ip: string) {
     
  }

  private parsePresets(c: ContextCache, d: any) {
     const l: { id: number; name: string }[] = [];
     if (typeof d === 'object' && d !== null) {
        for (const [k, v] of Object.entries(d)) {
            if (k === "0") continue; 
            if (!v || Object.keys(v as any).length === 0) continue; 
            l.push({ id: parseInt(k), name: (v as any).n || `Preset ${k}` });
        }
     }
     l.sort((a,b) => a.id - b.id); c.presets = l;
  }

  private async sendJson(ip: string, d: any) { 
      try { 
          await fetch(`http://${ip}/json/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
      } catch (e) { } 
  }

  // ACTIONS

  private changeBrightness(a: any, c: ContextCache, t: number) {
    const oldBri = c.state ? c.state.bri : 0;
    let b = oldBri + (t * 10); 
    if (b > 255) b = 255; 
    if (b < 0) b = 0;
    
    if (!c.state) c.state = { on: true, bri: b, ps: 0, pl: 0, seg: [{fx:0, sx:128, ix:128, pal:0}] };
    else c.state.bri = b;
    
    this.sendJson(c.ip!, { bri: b, on: true }); 
    this.updateDisplay(a, a.id); 
  }
  
  private changeEffect(a: any, c: ContextCache, t: number) {
     if(!c.state || !c.effects.length) return; 
     let f = (c.state.seg[0]?.fx || 0) + t;
     if (f >= c.effects.length) f = 0; if (f < 0) f = c.effects.length - 1;
     c.state.seg[0].fx = f; 
     this.sendJson(c.ip!, { seg: [{ id: 0, fx: f }] }); this.updateDisplay(a, a.id);
  }
  
  private changePalette(a: any, c: ContextCache, t: number) {
     if(!c.state || !c.palettes.length) return; 
     let p = (c.state.seg[0]?.pal || 0) + t;
     if (p >= c.palettes.length) p = 0; if (p < 0) p = c.palettes.length - 1;
     c.state.seg[0].pal = p;
     this.sendJson(c.ip!, { seg: [{ id: 0, pal: p }] }); this.updateDisplay(a, a.id);
  }
  
  private changePreset(a: any, c: ContextCache, t: number) {
     if (!c.presets.length) return; 
     let currentPs = c.state ? c.state.ps : 0;
     let idx = c.presets.findIndex(p => p.id === currentPs);
     if (idx === -1) idx = 0; 
     idx += t; if (idx >= c.presets.length) idx = 0; if (idx < 0) idx = c.presets.length - 1;
     const p = c.presets[idx]; 
     if (c.state) c.state.ps = p.id; 
     this.sendJson(c.ip!, { ps: p.id }); 
     this.updateDisplay(a, a.id);
  }

  // RELAY CONTROL
  private changeRelay(a: any, c: ContextCache, t: number) {
      if (!c.hasRelayUsermod) return; 
      
      const relayId = parseInt(c.settings.relayId || "0");
      const newState = t > 0;
      
      if (c.relayState !== newState) {
          c.relayState = newState;
          this.sendJson(c.ip!, { "MultiRelay": { "relay": relayId, "on": newState } });
          this.updateDisplay(a, a.id);
      }
  }

  // OWER TOGGLE (TOUCH)
  private togglePower(a: any, id: string) { 
      const c = this.cache.get(id); 
      if (!c || !c.ip || !c.state) return;

      // Debounce Check
      const now = Date.now();
      if (now - c.lastToggleTime < 500) {
          return; // Pressed too fast
      }
      c.lastToggleTime = now;

      const currentBri = c.state.bri;
      const isSoftOn = c.state.on && currentBri > 0;
      
      if (isSoftOn) {
          // Soft OFF -> Dim to 0
          c.lastBri = currentBri; 
          c.state.bri = 0; 
          // Send bri: 0. 
          this.sendJson(c.ip, { bri: 0 });
      } else {
          // Soft ON -> Restore
          let targetBri = c.lastBri;
          if (!targetBri || targetBri <= 0) targetBri = 128; 

          c.state.bri = targetBri;
          c.state.on = true; 
          // Send bri and on: true
          this.sendJson(c.ip, { bri: targetBri, on: true });
      }
      this.updateDisplay(a, id); 
  }

  // DISPLAY
  private updateDisplay(a: any, id: string) {
    const c = this.cache.get(id); 
    if(!a || !c) return;

    const s = c.settings || {};

    if (!c.ip) { 
        this.sendSvg(a, "WLED", "SETUP", c.lastError||"Setup Req.", true, false, 0, false, s); 
        return; 
    }
    
    const isOffline = c.isConnectionError;
    if (isOffline) {
        this.sendSvg(a, c.infoName || "WLED", "STATUS", "NO CONN", true, false, 0, false, s);
        return;
    }
    
    if (!c.state) {
         this.sendSvg(a, c.infoName || "WLED", "STATUS", "Loading...", false, false, 0, false, s);
         return;
    }

    const isOn = c.state.on && c.state.bri > 0;
    
    let briPct = Math.round(((c.state.bri || 0) / 255) * 100);
    if (isNaN(briPct)) briPct = 0;

    // SELECTION MODE
    if (c.selectionActive) {
        let m = c.pendingMode as string; 
        if (m === "BRIGHTNESS") m = "BRIGHTN"; 
        this.sendSvg(a, c.infoName, "SELECT", m, false, true, briPct, isOn, s);
        return;
    }

    // NORMAL MODE
    let l = "", v = "";
    let barPct = briPct; 
    let barActive = isOn;

    switch (c.currentMode) {
        case "BRIGHTNESS": 
            l = "BRIGHTN"; 
            v = !isOn ? "OFF" : `${briPct}%`; 
            break;
        case "EFFECT": 
            l = "EFFECT"; 
            const fxId = c.state.seg[0]?.fx || 0;
            v = c.effects[fxId] || `ID ${fxId}`; 
            break;
        case "PALETTE": 
            l = "PALETTE"; 
            const palId = c.state.seg[0]?.pal || 0;
            v = c.palettes[palId] || `ID ${palId}`; 
            break;
        case "PRESET": 
            l = "PRESET"; 
            let currentPs = c.state.ps;
            if (currentPs === undefined) currentPs = -1;
            if (currentPs <= 0 && c.lastValidPreset > 0) currentPs = c.lastValidPreset;
            const pre = c.presets.find(x => x.id === currentPs); 
            v = pre ? pre.name : (currentPs > 0 ? `ID ${currentPs}` : "None"); 
            break;
        case "RELAY":
            l = "RELAY";
            if (!c.hasRelayUsermod) {
                v = "NO RELAY";
            } else {
                v = c.relayState ? "ON" : "OFF";
            }
            break;
    }
    
    if (isOffline) {
        v = "NO CONN";
    }
    
    this.sendSvg(a, c.infoName, l, v, isOffline, false, barPct, barActive, s);
  }

  private sendSvg(a: any, name: string, label: string, val: string, err: boolean, sel: boolean, pct: number, isOn: boolean, settings: WledSettings) {
      const svg = this.genSvg(name, label, val, err, sel, pct, isOn, settings);
      const b64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      a.setFeedback({ full_display: b64, title: "", value: "", indicator: { value: 0, enabled: false } });
  }

  private genSvg(name: string, label: string, val: string, err: boolean, sel: boolean, pct: number, isOn: boolean, settings: WledSettings): string {
      let BG = "#000000";
      
      if (err) {
          if (settings && settings.showOfflineColor) BG = settings.offlineColor || "#FF9800";
      } else if (sel) { 
          BG = "#3984E9"; 
      }

      const TITLE_CLR = "#FFFFFF"; 
      const LABEL_CLR = (sel||err) ? "#FFFFFF" : "#3984E9"; 
      const VAL_CLR = "#FFFFFF"; 
      const STROKE_CLR = isOn ? "#ffffff" : "#666666"; 
      const BAR_FILL_CLR = isOn ? "#3984E9" : "#444444"; 

      const maxTotalChars = 22; 
      const labelOverhead = label.length + 3; 
      const maxNameChars = maxTotalChars - labelOverhead;
      
      if (name.length > maxNameChars) {
          name = name.substring(0, maxNameChars - 2) + "..";
      }

      const maxValLen = 18; 
      if (val.length > maxValLen) {
          val = val.substring(0, maxValLen - 2) + "..";
      }

      let fs = 24;
      if (!sel) { 
          if (val.length > 7) fs = 20; 
          if (val.length > 10) fs = 18; 
          if (val.length > 13) fs = 16; 
          if (val.length > 15) fs = 14; 
      } else {
          fs = 20;
      }

      let bar = "";
      if (typeof pct === 'number' && !isNaN(pct) && pct >= 0 && !sel && val !== "NO CONN") {
          const maxW = 192;
          const barWidth = maxW * (pct / 100);
          
          bar = `
            <rect x="4" y="76" width="${maxW}" height="10" rx="5" ry="5" fill="none" stroke="${STROKE_CLR}" stroke-width="1" />
            <rect x="5" y="77" width="${maxW-2}" height="8" fill="#333333" rx="4" ry="4"/>
            <rect x="5" y="77" width="${barWidth}" height="8" fill="${BAR_FILL_CLR}" rx="4" ry="4"/>
          `;
      }

      // Subtitle for errors - LARGER (14px Bold)
      let subText = "";
      if (val === "NO CONN") {
          subText = `<text x="127" y="85" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#DDDDDD">(OFFLINE?)</text>`;
      }

      return `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="100" fill="${BG}"/>
        <text x="5" y="22" text-anchor="start" font-family="sans-serif" font-size="14" font-weight="600" fill="${TITLE_CLR}">
            ${name} (<tspan fill="${LABEL_CLR}">${label}</tspan>)
        </text>
        <text x="127" y="60" text-anchor="middle" font-family="sans-serif" font-size="${fs}" font-weight="bold" fill="${VAL_CLR}">
            ${val}
        </text>
        ${subText}
        ${bar}
      </svg>`;
  }
}