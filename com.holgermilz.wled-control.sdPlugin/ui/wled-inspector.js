/// <reference path="sdpi-components.js" />

let globalSettings = {};

document.addEventListener('DOMContentLoaded', initInspector);

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initInspector();
}

function initInspector() {
    const foundSelect = document.getElementById('foundSelect');
    const ipField = document.getElementById('ipField');
    const relayCheck = document.getElementById('relayCheck');
    const relaySelect = document.getElementById('relaySelect');
    const relayError = document.getElementById('relayError');

    // Relay Logic (Checkbox & Dropdown
    // Function called when new settings arrive
    function updateRelayUI() {
        const count = globalSettings.relayCount || 0;
        const hasRelay = count > 0;

        if (relayCheck) {
            if (hasRelay) {
                // Relay present: Enable checkbox
                relayCheck.disabled = false;
                if (relayError) relayError.style.display = "none";
            } else {
                // No relay: Lock checkbox and uncheck
                if (relayCheck.checked) {
                    relayCheck.checked = false;
                    // Force save setting
                    globalSettings.showRelay = false;
                    saveSettings();
                    // Briefly show error
                    if (relayError) {
                        relayError.style.display = "block";
                        relayError.textContent = "Disabled: No MultiRelay found on device.";
                    }
                }
                relayCheck.disabled = true;
            }
        }

        // Rebuild dropdown
        if (relaySelect && hasRelay) {
            // Remember current selection
            const currentSel = globalSettings.relayId || "0";
            
            // Clear (but don't destroy completely; Elgato wrapper is sensitive)
            // Build HTML string
            let opts = "";
            for (let i = 0; i < count; i++) {
                const isSel = (i.toString() === currentSel) ? "selected" : "";
                opts += `<option value="${i}" ${isSel}>Relay ${i}</option>`;
            }
            relaySelect.innerHTML = opts;
            // Set value so SDPI detects it
            relaySelect.value = currentSel;
        } else if (relaySelect) {
            relaySelect.innerHTML = '<option value="0">No Relays found</option>';
            relaySelect.disabled = true;
        }
        
        if (relaySelect && hasRelay) relaySelect.disabled = false;
    }


    // Input Field Logic
    if (ipField) {
        ipField.removeAttribute('setting');
        ipField.addEventListener('input', (e) => {
            validateAndSave(e.target.value);
        });
    }

    // Dropdown Logic (IP Scanner) 
    if (foundSelect) {
        const internalSelect = foundSelect.querySelector('select') || foundSelect.shadowRoot?.querySelector('select');
        const handler = (e) => {
            const val = e.target.value;
            if (val) setIpFieldValue(val);
        };
        if (internalSelect) internalSelect.addEventListener('change', handler);
        else foundSelect.addEventListener('change', handler);
    }

    // Stream Deck Communication 
    if (window.SDPIComponents && window.SDPIComponents.streamDeckClient) {
        window.SDPIComponents.streamDeckClient.didReceiveSettings.subscribe(data => {
            globalSettings = data.payload.settings || {};

            if (globalSettings.foundDevices) updateDropdown(globalSettings.foundDevices);

            if (globalSettings.ipAddress && ipField && document.activeElement !== ipField) {
                setIpFieldValue(globalSettings.ipAddress, false);
            }
            
            // Sync checkbox status
            if (relayCheck && globalSettings.showRelay !== undefined) {
               if (document.activeElement !== relayCheck) {
                   relayCheck.checked = globalSettings.showRelay;
               }
            }

            // Update relay UI based on count
            updateRelayUI();
        });
    }
}

// --- HELPERS ---

function setIpFieldValue(val, save = true) {
    const ipField = document.getElementById('ipField');
    if (!ipField) return;
    ipField.value = val;
    ipField.setAttribute('value', val);
    const internalInput = ipField.shadowRoot?.querySelector('input') || ipField.querySelector('input');
    if (internalInput) internalInput.value = val;
    
    validateInput(val, internalInput);
    
    globalSettings.ipAddress = val;
    if (save) saveSettings();
}

function validateInput(ip, inputElement) {
    const ipv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    const hostname = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$|^wled(-[0-9]+)?$|^wled\.local$/;
    const isValid = ipv4.test(ip) || hostname.test(ip);
    if (inputElement) {
        if (!isValid && ip.length > 0) {
            inputElement.style.border = "2px solid #ff0000";
            inputElement.style.backgroundColor = "#440000";
            inputElement.style.color = "#ffffff";
        } else {
            inputElement.style.border = "";
            inputElement.style.backgroundColor = "";
            inputElement.style.color = "";
        }
    }
}

function validateAndSave(val) {
    const ipField = document.getElementById('ipField');
    const internalInput = ipField?.shadowRoot?.querySelector('input') || ipField?.querySelector('input');
    validateInput(val, internalInput);
    globalSettings.ipAddress = val;
    saveSettings();
}

function updateDropdown(devices) {
    const foundSelect = document.getElementById('foundSelect');
    const scanResult = document.getElementById('scanResult');
    
    
    const currentIp = globalSettings.ipAddress;
    const isManualIpFound = currentIp && devices.some(d => d.ip === currentIp);
    const manualDevice = devices.find(d => d.ip === currentIp);

    if (scanResult) {
        if (isManualIpFound && manualDevice) {
           
            scanResult.textContent = `Connected: ${manualDevice.name} (${manualDevice.ip})`;
            scanResult.style.color = "#4caf50"; 
        } else if (devices.length > 0) {
            scanResult.textContent = `Found ${devices.length} device(s) via Scan.`;
            scanResult.style.color = "#ccc"; 
        } else {
            scanResult.textContent = "No devices found yet.";
            scanResult.style.color = "#ff9800"; 
        }
    }

    if (!foundSelect) return;
    
    
    foundSelect.innerHTML = ""; 
    const def = document.createElement('option');
    def.textContent = "-- Select Device --";
    def.value = "";
    foundSelect.appendChild(def);
    
    devices.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.ip;
        opt.textContent = `${dev.name} (${dev.ip})`;
        if (globalSettings.ipAddress === dev.ip) opt.selected = true;
        foundSelect.appendChild(opt);
    });
}

function saveSettings() {
    if (window.SDPIComponents && window.SDPIComponents.streamDeckClient) {
        window.SDPIComponents.streamDeckClient.setSettings(globalSettings);
    }
}

window.scanNetwork = function() {
    const scanResult = document.getElementById('scanResult');
    if(scanResult) {
        scanResult.textContent = "Scanning... (please wait)";
        scanResult.style.color = "#ccc";
    }
    if (window.SDPIComponents && window.SDPIComponents.streamDeckClient) {
        window.SDPIComponents.streamDeckClient.send("sendToPlugin", { event: "startScan" });
    }
};