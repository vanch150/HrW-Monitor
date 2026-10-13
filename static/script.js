let ws = null;
let wsGeneration = 0;
let reconnectTimer = null;

const RECONNECT_DELAY_MS = 2000;
const MAX_HISTORY_POINTS = 60;
const ARC_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 -> 326.7256

let currentBpm = null;
let peakBpm = 0;
let avgBpm = 0;
let currentDelta = 0;
let btStatus = "searching";
let deviceName = "";
let simActive = false;

// Сценарный параметр ?layout=... из URL для независимых сцен в OBS
let urlLayoutOverride = null;

// История для плавного 60 FPS сплайна
let hrHistory = [];
let renderedHistory = [];

// Состояние ЭКГ-генератора
let ecgBuffer = [];
let ecgPhase = 0;
let lastFrameTime = performance.now();

// Таймеры дельты, симулятора и клатча
let deltaHideTimer = null;
let clutchInterval = null;
let simThrottleTimer = null;

// Web Audio API синтезатор стука сердца
let audioCtx = null;
let nextHeartbeatTime = 0;

let cfg = {
    layout: "classic",
    mode_visual: "smart",
    thresh_med: 100,
    thresh_high: 140,
    c_low: "#00ffcc",
    c_med: "#ffaa00",
    c_high: "#ff0055",
    bpm_min: 50,
    bpm_max: 200,
    bg: true,
    bg_opacity: 0.85,
    pos: "pos-center",
    size: 100,
    showHeader: false,
    customTitle: "",
    showPeak: true,
    showBar: true,
    showGraph: true,
    gif_scale: 1.0,
    gif_pulse: false,
    color_lerp: true,
    number_anim: "odometer",
    show_delta: true,
    delta_threshold: 12,
    graph_thresholds: true,
    audio_enabled: false,
    audio_volume: 0.35
};

let gifs = { low: null, med: null, high: null, global: null };

// Безопасные обёртки для работы с DOM (защищают от падения при отсутствии элемента)
function setVal(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
}

function setChecked(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(val);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.textContent = String(val);
}

function getVal(id, fallback = "") {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
}

function getChecked(id, fallback = false) {
    const el = document.getElementById(id);
    return el ? Boolean(el.checked) : fallback;
}

function init() {
    const params = new URLSearchParams(window.location.search);
    if (params.has("obs")) {
        document.body.classList.add("obs-mode");
    }
    const layoutParam = params.get("layout");
    if (layoutParam && ["classic", "cyber", "pill", "ecg", "arc"].includes(layoutParam)) {
        urlLayoutOverride = layoutParam;
    }

    document.addEventListener("visibilitychange", () => {
        document.body.classList.toggle("page-hidden", document.hidden);
    });

    bindEvents();
    applySettings();
    updateVisuals(currentBpm);
    connectWs();
    requestAnimationFrame(renderLoop);
}

function clearReconnectTimer() {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect(myGeneration) {
    if (myGeneration !== wsGeneration) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(connectWs, RECONNECT_DELAY_MS);
}

function connectWs() {
    clearReconnectTimer();

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        const stale = ws;
        stale.onopen = stale.onmessage = stale.onclose = stale.onerror = null;
        try { stale.close(); } catch (_) {}
    }

    wsGeneration += 1;
    const myGeneration = wsGeneration;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws = socket;

    socket.onmessage = (e) => {
        if (myGeneration !== wsGeneration) return;
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch (_) {
            return;
        }

        if (msg.type === "hr") {
            handleHrPacket(msg);
        } else if (msg.type === "config_update") {
            cfg = { ...cfg, ...(msg.settings || {}) };
            gifs = msg.gifs || gifs;
            applySettings();
            updateVisuals(currentBpm);
        } else if (msg.type === "session_state") {
            handleSessionSnapshot(msg);
        } else if (msg.type === "ping") {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "pong" }));
            }
        }
    };

    socket.onclose = () => {
        btStatus = "searching";
        updateStatusHeader();
        scheduleReconnect(myGeneration);
    };

    socket.onerror = () => {
        try { socket.close(); } catch (_) {}
    };
}

function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function handleSessionSnapshot(snap) {
    if (Array.isArray(snap.history) && snap.history.length > 0) {
        hrHistory = snap.history.slice(-MAX_HISTORY_POINTS);
        if (renderedHistory.length !== hrHistory.length) {
            renderedHistory = [...hrHistory];
        }
    } else if (snap.peak_bpm === 0) {
        hrHistory = [];
        renderedHistory = [];
    }

    peakBpm = Number(snap.peak_bpm) || 0;
    avgBpm = Number(snap.avg_bpm) || 0;
    currentDelta = Number(snap.delta) || 0;
    btStatus = snap.bt_status || "searching";
    deviceName = snap.device_name || "";
    simActive = Boolean(snap.sim_active);

    if (snap.current_bpm !== null && snap.current_bpm !== undefined) {
        currentBpm = Number(snap.current_bpm);
        renderBpmNumber(currentBpm, false);
    } else if (snap.peak_bpm === 0) {
        currentBpm = null;
        renderBpmNumber(null, false);
    }

    updateStatsUI();
    updateStatusHeader();
    updateVisuals(currentBpm);
}

function handleHrPacket(msg) {
    const bpm = Number(msg.val);
    if (!Number.isFinite(bpm) || bpm <= 0) return;

    const prevBpm = currentBpm;
    currentBpm = bpm;

    if (typeof msg.peak === "number") peakBpm = msg.peak;
    else if (bpm > peakBpm) peakBpm = bpm;

    if (typeof msg.avg === "number") avgBpm = msg.avg;
    if (typeof msg.delta === "number") currentDelta = msg.delta;
    if (typeof msg.sim === "boolean") simActive = msg.sim;

    if (!simActive) btStatus = "connected";

    if (hrHistory.length === 0) {
        hrHistory = new Array(MAX_HISTORY_POINTS).fill(bpm);
        renderedHistory = [...hrHistory];
    } else {
        hrHistory.push(bpm);
        if (hrHistory.length > MAX_HISTORY_POINTS) hrHistory.shift();
        while (renderedHistory.length < hrHistory.length) {
            renderedHistory.unshift(bpm);
        }
        if (renderedHistory.length > hrHistory.length) {
            renderedHistory.shift();
        }
    }

    const jumpedRapidly = prevBpm !== null && Math.abs(bpm - prevBpm) >= 5;
    renderBpmNumber(bpm, jumpedRapidly);
    checkStressDelta(currentDelta);
    updateStatsUI();
    updateStatusHeader();
    updateVisuals(bpm);
}

function renderBpmNumber(bpm, triggerPop) {
    const valEl = document.getElementById("val");
    if (!valEl) return;

    const text = bpm === null ? "--" : String(Math.round(bpm));
    valEl.setAttribute("data-text", text);

    const animMode = cfg.number_anim || "odometer";

    if (bpm === null || animMode !== "odometer") {
        valEl.textContent = text;
    } else {
        const digits = text.split("");
        const existingCols = valEl.querySelectorAll(".odo-digit");

        if (existingCols.length !== digits.length) {
            valEl.innerHTML = "";
            digits.forEach((d) => {
                const col = document.createElement("span");
                col.className = "odo-digit";
                const ribbon = document.createElement("span");
                ribbon.className = "odo-ribbon";
                for (let n = 0; n <= 9; n++) {
                    const sp = document.createElement("span");
                    sp.textContent = String(n);
                    ribbon.appendChild(sp);
                }
                const num = parseInt(d, 10) || 0;
                ribbon.style.transform = `translateY(-${num * 1.06}em)`;
                col.appendChild(ribbon);
                valEl.appendChild(col);
            });
        } else {
            digits.forEach((d, idx) => {
                const ribbon = existingCols[idx].querySelector(".odo-ribbon");
                if (ribbon) {
                    const num = parseInt(d, 10) || 0;
                    ribbon.style.transform = `translateY(-${num * 1.06}em)`;
                }
            });
        }
    }

    if (triggerPop && animMode !== "none") {
        valEl.classList.remove("anim-pop");
        void valEl.offsetWidth;
        valEl.classList.add("anim-pop");
    }
}

function checkStressDelta(delta) {
    const badge = document.getElementById("deltaBadge");
    const card = document.getElementById("cardBase");
    if (!badge || !card) return;

    const thresh = Number(cfg.delta_threshold) || 12;
    if (!cfg.show_delta || delta < thresh) {
        return;
    }

    badge.textContent = `+${delta} ⚡`;
    badge.classList.add("visible");

    card.classList.remove("stress-flash");
    void card.offsetWidth;
    card.classList.add("stress-flash");

    if (deltaHideTimer) clearTimeout(deltaHideTimer);
    deltaHideTimer = setTimeout(() => {
        badge.classList.remove("visible");
    }, 4000);
}

function updateStatsUI() {
    setText("peak", peakBpm);
    setText("hudAvgVal", avgBpm > 0 ? avgBpm : "--");

    if (!document.body.classList.contains("obs-mode")) {
        setText("statAvg", avgBpm > 0 ? avgBpm : "--");
        setText("statPeak", peakBpm);
    }
}

function updateStatusHeader() {
    if (document.body.classList.contains("obs-mode")) return;
    const dot = document.getElementById("panelStatusDot");
    const txt = document.getElementById("btStatusText");
    const simToggle = document.getElementById("simToggle");

    if (simToggle && simToggle.checked !== simActive) {
        simToggle.checked = simActive;
    }

    if (!dot || !txt) return;
    dot.classList.remove("connected", "simulator");

    if (simActive) {
        dot.classList.add("simulator");
        txt.textContent = `Режим симулятора (${currentBpm ?? "--"} BPM)`;
    } else if (btStatus === "connected") {
        dot.classList.add("connected");
        txt.textContent = deviceName ? `Подключено: ${deviceName}` : "Датчик подключен";
    } else {
        txt.textContent = "Поиск BLE-датчика...";
    }
}

function hexToRgbArray(hex) {
    const clean = String(hex || "#00ffcc").replace("#", "");
    if (clean.length !== 6) return [0, 255, 204];
    return [
        parseInt(clean.slice(0, 2), 16) || 0,
        parseInt(clean.slice(2, 4), 16) || 0,
        parseInt(clean.slice(4, 6), 16) || 0
    ];
}

function rgbArrayToHex(rgb) {
    return (
        "#" +
        rgb
            .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
            .join("")
    );
}

function lerpRgb(c1, c2, t) {
    const clamped = Math.max(0, Math.min(1, t));
    return [
        c1[0] + (c2[0] - c1[0]) * clamped,
        c1[1] + (c2[1] - c1[1]) * clamped,
        c1[2] + (c2[2] - c1[2]) * clamped
    ];
}

function computeZoneColor(bpm) {
    const tMed = Number(cfg.thresh_med) || 100;
    const tHigh = Number(cfg.thresh_high) || 140;
    const bMin = Number(cfg.bpm_min) || 50;

    if (bpm === null || bpm <= 0) {
        const rgb = hexToRgbArray(cfg.c_low);
        return { hex: cfg.c_low, rgbStr: rgb.join(", "), zone: "low" };
    }

    let zone = "low";
    if (bpm >= tHigh) zone = "high";
    else if (bpm >= tMed) zone = "med";

    if (!cfg.color_lerp) {
        const hex = zone === "high" ? cfg.c_high : zone === "med" ? cfg.c_med : cfg.c_low;
        const rgb = hexToRgbArray(hex);
        return { hex, rgbStr: rgb.join(", "), zone };
    }

    const rgbLow = hexToRgbArray(cfg.c_low);
    const rgbMed = hexToRgbArray(cfg.c_med);
    const rgbHigh = hexToRgbArray(cfg.c_high);

    let outRgb;
    if (bpm <= bMin) {
        outRgb = rgbLow;
    } else if (bpm < tMed) {
        const ratio = (bpm - bMin) / Math.max(1, tMed - bMin);
        outRgb = lerpRgb(rgbLow, rgbMed, ratio);
    } else if (bpm < tHigh) {
        const ratio = (bpm - tMed) / Math.max(1, tHigh - tMed);
        outRgb = lerpRgb(rgbMed, rgbHigh, ratio);
    } else {
        outRgb = rgbHigh;
    }

    return {
        hex: rgbArrayToHex(outRgb),
        rgbStr: outRgb.map((v) => Math.round(v)).join(", "),
        zone
    };
}

function isVideoUrl(url) {
    if (!url) return false;
    const clean = url.split("?")[0].toLowerCase();
    return clean.endsWith(".webm") || clean.endsWith(".mp4");
}

function updateVisuals(bpm) {
    const effectiveBpm = bpm ?? 0;
    const { hex, rgbStr, zone } = computeZoneColor(bpm);
    const dangerRgb = hexToRgbArray(cfg.c_high).join(", ");

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--primary", hex);
    rootStyle.setProperty("--primary-rgb", rgbStr);
    rootStyle.setProperty("--danger", cfg.c_high);
    rootStyle.setProperty("--danger-rgb", dangerRgb);
    rootStyle.setProperty("--media-scale", String(cfg.gif_scale || 1.0));

    const mediaContainer = document.getElementById("mediaContainer");
    const imgEl = document.getElementById("customGif");
    const videoEl = document.getElementById("customVideo");
    const iconEl = document.getElementById("defaultIcon");
    const rippleEl = document.getElementById("heartRipple");
    const mode = cfg.mode_visual || "smart";

    let targetMedia = null;
    if (mode === "one_gif") targetMedia = gifs.global;
    else if (mode === "smart") targetMedia = gifs[zone] || gifs.global;

    if (mediaContainer && imgEl && videoEl && iconEl && rippleEl) {
        if (mode === "icon" || !targetMedia) {
            mediaContainer.classList.add("is-icon-mode");
            imgEl.style.display = "none";
            videoEl.style.display = "none";
            try { videoEl.pause(); } catch (_) {}
            iconEl.style.display = "flex";
            rippleEl.classList.add("active");
        } else {
            mediaContainer.classList.remove("is-icon-mode");
            iconEl.style.display = "none";
            rippleEl.classList.remove("active");

            if (isVideoUrl(targetMedia)) {
                imgEl.style.display = "none";
                if (videoEl.getAttribute("data-src") !== targetMedia) {
                    videoEl.setAttribute("data-src", targetMedia);
                    videoEl.src = targetMedia;
                    videoEl.play().catch(() => {});
                }
                videoEl.style.display = "block";
                videoEl.classList.toggle("beating", Boolean(cfg.gif_pulse));
                imgEl.classList.remove("beating");
            } else {
                videoEl.style.display = "none";
                try { videoEl.pause(); } catch (_) {}
                if (imgEl.getAttribute("data-src") !== targetMedia) {
                    imgEl.setAttribute("data-src", targetMedia);
                    imgEl.src = targetMedia;
                }
                imgEl.style.display = "block";
                imgEl.classList.toggle("beating", Boolean(cfg.gif_pulse));
                videoEl.classList.remove("beating");
            }
        }
    }

    const card = document.getElementById("cardBase");
    if (card) {
        card.classList.toggle("danger-active", zone === "high");
    }

    const minBpm = Number(cfg.bpm_min) || 50;
    const maxBpm = Math.max(minBpm + 1, Number(cfg.bpm_max) || 200);
    const pct = bpm === null ? 0 : Math.max(0, Math.min(100, ((effectiveBpm - minBpm) / (maxBpm - minBpm)) * 100));

    const hpFill = document.getElementById("hpFill");
    if (hpFill) hpFill.style.width = `${pct}%`;

    const arcFill = document.getElementById("arcFill");
    if (arcFill) {
        const offset = ARC_CIRCUMFERENCE * (1 - pct / 100);
        arcFill.style.strokeDashoffset = offset.toFixed(2);
    }

    const beatBpm = bpm === null ? 60 : Math.max(35, Math.min(effectiveBpm, 240));
    const speed = (60 / beatBpm).toFixed(3) + "s";
    rootStyle.setProperty("--beat-speed", speed);
}

function renderLoop(now) {
    requestAnimationFrame(renderLoop);
    if (document.hidden) return;

    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (cfg.audio_enabled && currentBpm !== null && currentBpm >= (Number(cfg.thresh_high) || 140)) {
        scheduleHeartbeatAudio(now);
    }

    const activeLayout = urlLayoutOverride || cfg.layout || "classic";
    if (!cfg.showGraph && activeLayout !== "ecg") return;

    const canvas = document.getElementById("hrGraph");
    if (!canvas) return;

    const logicalW = canvas.clientWidth;
    const logicalH = canvas.clientHeight;
    if (logicalW <= 0 || logicalH <= 0) return;

    const scaleFactor = Math.max(0.5, (Number(cfg.size) || 100) / 100);
    const dpr = (window.devicePixelRatio || 1) * scaleFactor;
    const targetW = Math.round(logicalW * dpr);
    const targetH = Math.round(logicalH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);

    if (activeLayout === "ecg") {
        drawEcgOscilloscope(ctx, logicalW, logicalH, dt);
    } else {
        drawSmoothSplineGraph(ctx, logicalW, logicalH, dt, activeLayout);
    }

    ctx.restore();
}

function drawSmoothSplineGraph(ctx, width, height, dt, activeLayout) {
    ctx.clearRect(0, 0, width, height);

    const minBpm = Number(cfg.bpm_min) || 50;
    const maxBpm = Math.max(minBpm + 10, Number(cfg.bpm_max) || 200);
    const range = maxBpm - minBpm;

    if (hrHistory.length === 0) {
        const base = currentBpm ?? minBpm;
        hrHistory = new Array(MAX_HISTORY_POINTS).fill(base);
        renderedHistory = [...hrHistory];
    }

    const lerpFactor = Math.min(1, dt * 10);
    for (let i = 0; i < hrHistory.length; i++) {
        const target = hrHistory[i];
        const cur = renderedHistory[i] ?? target;
        renderedHistory[i] = cur + (target - cur) * lerpFactor;
    }

    const padY = 5;
    const usableH = Math.max(10, height - padY * 2);
    const toY = (val) => {
        const clamped = Math.max(minBpm, Math.min(maxBpm, val));
        return (1 - (clamped - minBpm) / range) * usableH + padY;
    };

    if (cfg.graph_thresholds && activeLayout !== "pill") {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.font = "700 9px 'JetBrains Mono', monospace";

        const thresholds = [
            { val: Number(cfg.thresh_med) || 100, color: cfg.c_med },
            { val: Number(cfg.thresh_high) || 140, color: cfg.c_high }
        ];

        thresholds.forEach((t) => {
            if (t.val > minBpm && t.val < maxBpm) {
                const y = Math.round(toY(t.val)) + 0.5;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();

                ctx.fillStyle = "rgba(255, 255, 255, 0.38)";
                ctx.fillText(String(t.val), 4, Math.max(8, y - 2));
            }
        });
        ctx.restore();
    }

    const data = renderedHistory;
    if (data.length < 2) return;

    const rightMargin = activeLayout === "pill" ? 3 : 6;
    const stepX = (width - rightMargin) / (data.length - 1);
    const points = data.map((val, i) => ({
        x: i * stepX,
        y: toY(val)
    }));

    const { hex, rgbStr } = computeZoneColor(currentBpm);

    ctx.beginPath();
    ctx.lineWidth = activeLayout === "pill" ? 2.0 : 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = hex;

    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();

    ctx.lineTo(last.x, height);
    ctx.lineTo(0, height);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${rgbStr}, 0.35)`);
    grad.addColorStop(1, `rgba(${rgbStr}, 0.0)`);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = hex;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(last.x, last.y, activeLayout === "pill" ? 2.2 : 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function evaluatePQRST(phase) {
    const p = phase % 1;
    const gauss = (center, width, amp) => {
        const d = (p - center) / width;
        return amp * Math.exp(-0.5 * d * d);
    };
    return (
        gauss(0.18, 0.032, 0.16) -
        gauss(0.28, 0.012, 0.18) +
        gauss(0.31, 0.013, 1.0) -
        gauss(0.34, 0.014, 0.32) +
        gauss(0.52, 0.048, 0.24)
    );
}

function drawEcgOscilloscope(ctx, width, height, dt) {
    ctx.clearRect(0, 0, width, height);

    const bpm = currentBpm ?? 60;
    const freqHz = Math.max(0.6, Math.min(3.8, bpm / 60));
    ecgPhase = (ecgPhase + dt * freqHz) % 1;

    const midY = height * 0.58;
    const ampY = height * 0.42;
    const sampleY = midY - evaluatePQRST(ecgPhase) * ampY;

    const maxPoints = Math.max(80, Math.floor(width / 2));
    ecgBuffer.push(sampleY);
    while (ecgBuffer.length > maxPoints) {
        ecgBuffer.shift();
    }

    if (ecgBuffer.length < 2) return;

    const { hex, rgbStr } = computeZoneColor(currentBpm);
    const stepX = (width - 6) / (maxPoints - 1);

    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, `rgba(${rgbStr}, 0.05)`);
    grad.addColorStop(0.35, `rgba(${rgbStr}, 0.55)`);
    grad.addColorStop(1, hex);
    ctx.strokeStyle = grad;

    ctx.beginPath();
    for (let i = 0; i < ecgBuffer.length; i++) {
        const x = i * stepX;
        const y = ecgBuffer[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const headX = (ecgBuffer.length - 1) * stepX;
    const headY = ecgBuffer[ecgBuffer.length - 1];
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = hex;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(headX, headY, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function scheduleHeartbeatAudio(nowMs) {
    const periodMs = (60 / Math.max(40, Math.min(240, currentBpm || 80))) * 1000;
    if (nowMs < nextHeartbeatTime) return;
    nextHeartbeatTime = nowMs + periodMs;

    try {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }

        const tHigh = Number(cfg.thresh_high) || 140;
        const maxBpm = Number(cfg.bpm_max) || 200;
        const intensity = Math.max(0.25, Math.min(1.0, ((currentBpm || tHigh) - tHigh) / Math.max(10, maxBpm - tHigh) + 0.3));
        const masterVol = (Number(cfg.audio_volume) || 0.35) * intensity;

        triggerHeartThump(audioCtx.currentTime, 62, masterVol);
        triggerHeartThump(audioCtx.currentTime + 0.14, 48, masterVol * 0.65);
    } catch (_) {}
}

function triggerHeartThump(startTime, freq, volume) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startTime);
    osc.frequency.exponentialRampToValueAtTime(26, startTime + 0.11);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.13);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.onended = () => {
        try {
            osc.disconnect();
            gain.disconnect();
        } catch (_) {}
    };

    osc.start(startTime);
    osc.stop(startTime + 0.14);
}

function bindEvents() {
    const controlIds = [
        "sLayout", "sVisualMode", "sGifScale", "sGifPulse", "sNumberAnim",
        "sCLow", "sCMed", "sCHigh", "sTMed", "sTHigh", "sColorLerp",
        "sShowDelta", "sDeltaThresh", "sAudioEnabled", "sAudioVolume",
        "sBpmMin", "sBpmMax", "sShowHeader", "sCustomTitle",
        "sShowPeak", "sShowBar", "sShowGraph",
        "sGraphThresholds", "sBg", "sBgOpacity", "sSize", "sPos"
    ];

    controlIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const evt = (el.type === "range" || el.type === "color" || el.type === "text") ? "input" : "change";
        el.addEventListener(evt, pushSettings);
    });
}

function pushSettings() {
    let tMed = parseInt(getVal("sTMed", 100), 10) || 100;
    let tHigh = parseInt(getVal("sTHigh", 140), 10) || 140;
    if (tHigh <= tMed) tHigh = tMed + 10;

    let bMin = parseInt(getVal("sBpmMin", 50), 10) || 50;
    let bMax = parseInt(getVal("sBpmMax", 200), 10) || 200;
    if (bMax <= bMin) bMax = bMin + 10;

    cfg.layout = getVal("sLayout", "classic");
    cfg.mode_visual = getVal("sVisualMode", "smart");
    cfg.gif_scale = parseFloat(getVal("sGifScale", 1.0)) || 1.0;
    cfg.gif_pulse = getChecked("sGifPulse", false);
    cfg.number_anim = getVal("sNumberAnim", "odometer");

    cfg.c_low = getVal("sCLow", "#00ffcc");
    cfg.c_med = getVal("sCMed", "#ffaa00");
    cfg.c_high = getVal("sCHigh", "#ff0055");
    cfg.thresh_med = tMed;
    cfg.thresh_high = tHigh;
    cfg.color_lerp = getChecked("sColorLerp", true);

    cfg.show_delta = getChecked("sShowDelta", true);
    cfg.delta_threshold = parseInt(getVal("sDeltaThresh", 12), 10) || 12;
    cfg.audio_enabled = getChecked("sAudioEnabled", false);
    cfg.audio_volume = parseFloat(getVal("sAudioVolume", 0.35)) || 0.35;

    cfg.bpm_min = bMin;
    cfg.bpm_max = bMax;
    cfg.showHeader = getChecked("sShowHeader", false);
    cfg.customTitle = String(getVal("sCustomTitle", "")).slice(0, 40);
    cfg.showPeak = getChecked("sShowPeak", true);
    cfg.showBar = getChecked("sShowBar", true);
    cfg.showGraph = getChecked("sShowGraph", true);
    cfg.graph_thresholds = getChecked("sGraphThresholds", true);
    cfg.bg = getChecked("sBg", true);
    cfg.bg_opacity = parseFloat(getVal("sBgOpacity", 0.85)) || 0.85;

    cfg.size = parseInt(getVal("sSize", 100), 10) || 100;
    cfg.pos = getVal("sPos", "pos-center");

    applySettings();
    updateVisuals(currentBpm);
    sendWs({ type: "settings", data: cfg });
}

function applySettings() {
    const activeLayout = urlLayoutOverride || cfg.layout || "classic";

    if (!document.body.classList.contains("obs-mode")) {
        const m = cfg.mode_visual || "smart";
        setVal("sLayout", cfg.layout || "classic");
        setVal("sVisualMode", m);

        const secOne = document.getElementById("sec-one-gif");
        const secSmart = document.getElementById("sec-smart");
        if (secOne) secOne.style.display = m === "one_gif" ? "block" : "none";
        if (secSmart) secSmart.style.display = m === "smart" ? "block" : "none";

        setVal("sGifScale", cfg.gif_scale ?? 1.0);
        setChecked("sGifPulse", cfg.gif_pulse);
        setVal("sNumberAnim", cfg.number_anim || "odometer");

        setVal("sCLow", cfg.c_low);
        setVal("sCMed", cfg.c_med);
        setVal("sCHigh", cfg.c_high);
        setVal("sTMed", cfg.thresh_med);
        setVal("sTHigh", cfg.thresh_high);
        setText("v_t_med", cfg.thresh_med);
        setText("v_t_high", cfg.thresh_high);
        setChecked("sColorLerp", cfg.color_lerp);

        setChecked("sShowDelta", cfg.show_delta);
        setVal("sDeltaThresh", cfg.delta_threshold ?? 12);
        setChecked("sAudioEnabled", cfg.audio_enabled);
        setVal("sAudioVolume", cfg.audio_volume ?? 0.35);

        setVal("sBpmMin", cfg.bpm_min);
        setVal("sBpmMax", cfg.bpm_max);
        setChecked("sShowHeader", cfg.showHeader);

        const titleInput = document.getElementById("sCustomTitle");
        if (titleInput && document.activeElement !== titleInput) {
            titleInput.value = cfg.customTitle || "";
        }

        setChecked("sShowPeak", cfg.showPeak);
        setChecked("sShowBar", cfg.showBar);
        setChecked("sShowGraph", cfg.showGraph);
        setChecked("sGraphThresholds", cfg.graph_thresholds);
        setChecked("sBg", cfg.bg);
        setVal("sBgOpacity", cfg.bg_opacity ?? 0.85);

        setVal("sSize", cfg.size);
        setVal("sPos", cfg.pos);

        updateObsLinkField();
    }

    document.body.setAttribute("data-layout", activeLayout);

    const posWrap = document.getElementById("pos-wrapper");
    if (posWrap) posWrap.className = cfg.pos || "pos-center";

    const scaler = document.getElementById("scaler");
    if (scaler) scaler.style.transform = `scale(${(cfg.size || 100) / 100})`;

    document.documentElement.style.setProperty("--bg-opacity", cfg.bg_opacity ?? 0.85);

    const titleTag = document.getElementById("hudTitleTag");
    if (titleTag) {
        titleTag.textContent = (cfg.customTitle || "").trim();
    }

    const card = document.getElementById("cardBase");
    if (card) {
        card.setAttribute("data-layout", activeLayout);
        card.classList.toggle("has-bg", Boolean(cfg.bg));
        card.classList.toggle("show-header", Boolean(cfg.showHeader));
        card.classList.toggle("hide-peak", !cfg.showPeak);
        card.classList.toggle("hide-bar", !cfg.showBar);
        card.classList.toggle("hide-graph", !cfg.showGraph);
    }

    renderBpmNumber(currentBpm, false);
}

function toggleSimulator(checked) {
    simActive = Boolean(checked);
    if (!simActive && clutchInterval) {
        clearInterval(clutchInterval);
        clutchInterval = null;
        setText("btnClutchSim", "🔥 Симуляция клатча (65 → 165 BPM)");
    }
    const sliderVal = parseInt(getVal("simBpmRange", 75), 10) || 75;
    sendWs({ type: "sim_toggle", active: simActive, val: sliderVal });
    updateStatusHeader();
}

function onSimSliderInput(val) {
    const num = parseInt(val, 10) || 75;
    setText("simBpmVal", num);

    const simToggle = document.getElementById("simToggle");
    if (simToggle && !simToggle.checked) {
        simToggle.checked = true;
        simActive = true;
    }

    if (!simThrottleTimer) {
        simThrottleTimer = setTimeout(() => {
            simThrottleTimer = null;
            const latest = parseInt(getVal("simBpmRange", num), 10) || num;
            sendWs({ type: "sim_bpm", val: latest });
        }, 150);
    }
}

function startClutchSimulation() {
    if (clutchInterval) {
        clearInterval(clutchInterval);
        clutchInterval = null;
        setText("btnClutchSim", "🔥 Симуляция клатча (65 → 165 BPM)");
        return;
    }

    setChecked("simToggle", true);
    simActive = true;
    setText("btnClutchSim", "⏹ Остановить симуляцию клатча");

    const keyframes = [65, 68, 74, 92, 114, 132, 148, 158, 165, 162, 154, 142, 128, 112, 96, 84, 74];
    let step = 0;

    const pushStep = () => {
        if (step >= keyframes.length) {
            clearInterval(clutchInterval);
            clutchInterval = null;
            setText("btnClutchSim", "🔥 Симуляция клатча (65 → 165 BPM)");
            return;
        }
        const bpm = keyframes[step++];
        setVal("simBpmRange", bpm);
        setText("simBpmVal", bpm);
        sendWs({ type: "sim_bpm", val: bpm });
    };

    pushStep();
    clutchInterval = setInterval(pushStep, 900);
}

function uploadGif(cat) {
    const input = document.getElementById("hiddenInput");
    if (!input) return;

    input.onchange = async () => {
        const file = input.files[0];
        input.value = "";
        if (!file) return;

        try {
            const buffer = await file.arrayBuffer();
            const res = await fetch(`/api/upload/${encodeURIComponent(cat)}`, {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: buffer
            });
            const data = await res.json();
            if (data.ok && data.gifs) {
                gifs = data.gifs;
                updateVisuals(currentBpm);
            }
        } catch (err) {
            console.error("Ошибка загрузки медиа:", err);
        }
    };
    input.click();
}

async function clearGif(cat) {
    try {
        const res = await fetch(`/api/upload/${encodeURIComponent(cat)}`, {
            method: "DELETE"
        });
        const data = await res.json();
        if (data.ok && data.gifs) {
            gifs = data.gifs;
            updateVisuals(currentBpm);
        }
    } catch (err) {
        sendWs({ type: "upload_gif", category: cat, data: null });
    }
}

async function resetSessionPeak() {
    try {
        await fetch("/api/session/reset", { method: "POST" });
    } catch (_) {
        sendWs({ type: "reset_peak" });
    }
}

function exportSessionCsv() {
    window.open("/api/session/export", "_blank");
}

function togglePanel() {
    const panel = document.getElementById("panel");
    if (panel) panel.classList.toggle("open");
}

function buildObsUrl() {
    const base = `${window.location.protocol}//${window.location.host}/?obs`;
    if (urlLayoutOverride) {
        return `${base}&layout=${encodeURIComponent(urlLayoutOverride)}`;
    }
    return base;
}

function updateObsLinkField() {
    setVal("obsLinkField", buildObsUrl());
}

function copyObsLink() {
    const obsUrl = buildObsUrl();
    const btn = document.getElementById("btnCopyObs");
    const hint = document.getElementById("obsCopyHint");
    const field = document.getElementById("obsLinkField");

    if (field) {
        field.focus();
        field.select();
    }

    navigator.clipboard.writeText(obsUrl).then(() => {
        if (btn) btn.textContent = "Скопировано ✓";
        if (hint) {
            hint.style.color = "#00ffcc";
            hint.textContent = "Ссылка в буфере! Вставь её в источник «Браузер» в OBS (1920×1080).";
        }
        setTimeout(() => {
            if (btn) btn.textContent = "Копировать";
            if (hint) {
                hint.style.color = "";
                hint.textContent = "Вставь ссылку в источник «Браузер» в OBS (1920×1080)";
            }
        }, 2800);
    }).catch(() => {
        if (hint) {
            hint.style.color = "#ffaa00";
            hint.textContent = "Ссылка выделена в поле выше — нажми Ctrl+C для копирования.";
        }
    });
}

window.togglePanel = togglePanel;
window.uploadGif = uploadGif;
window.clearGif = clearGif;
window.copyObsLink = copyObsLink;
window.toggleSimulator = toggleSimulator;
window.onSimSliderInput = onSimSliderInput;
window.startClutchSimulation = startClutchSimulation;
window.resetSessionPeak = resetSessionPeak;
window.exportSessionCsv = exportSessionCsv;

init();