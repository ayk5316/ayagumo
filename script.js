const APP_CONFIG = {
  center: [34.6903, 135.5663],
  mapZoom: 7,
  analysisZoom: 7,
  refreshIntervalMs: 5 * 60 * 1000,
  locationClusterOffset: 0.015,
  rainViewerUrl: "https://api.rainviewer.com/public/weather-maps.json",
  regionSamples: [
    { lat: 34.6937, lon: 135.5023 }, // 大阪市中心部
    { lat: 34.7024, lon: 135.5400 }, // 城東〜鶴見
    { lat: 34.6796, lon: 135.5621 }, // 東成〜東大阪西側
    { lat: 34.6670, lon: 135.5900 }, // 東大阪中央寄り
    { lat: 34.6888, lon: 135.6208 }, // 東大阪東側
  ],
};

const AVATAR_PATTERNS = {
  safe: {
    image: "./assets/IMG_4692.JPG",
    comment: "よゆーで おでかけ できる！",
  },
  soonRain: {
    image: "./assets/IMG_4694.JPG",
    comment: "もうすぐ あめ ふるっぽい！",
  },
  soonClear: {
    image: "./assets/IMG_4690.JPG",
    comment: "もうすぐ やむっぽい！",
  },
  rain: {
    image: "./assets/IMG_4696.JPG",
    comment: "ずっとあめ もう おしまい あたまいたい",
  },
  error: {
    image: "./assets/IMG_4694.JPG",
    comment: "いま でーた よめない…",
  },
};

const TRANSPARENT_TILE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const SIGNAL_META = {
  safe: { label: "雨なし", className: "dot-safe", rank: 0 },
  soon: { label: "もうすぐ変化", className: "dot-soon", rank: 1 },
  rain: { label: "しっかり雨", className: "dot-rain", rank: 2 },
};

const TIME_SLOTS = [
  { label: "今", minutes: 0 },
  { label: "30分後", minutes: 30 },
  { label: "1時間後", minutes: 60 },
];

const state = {
  map: null,
  radarLayer: null,
  frames: [],
  snapshots: [],
  activeIndex: 0,
  frameHost: "",
  tileCache: new Map(),
  refreshTimer: null,
  userLocation: null,
  analysisMode: "region",
};

const dom = {
  avatarImage: document.getElementById("avatarImage"),
  avatarComment: document.getElementById("avatarComment"),
  locationLabel: document.getElementById("locationLabel"),
  locationText: document.getElementById("locationText"),
  statusText: document.getElementById("statusText"),
  updatedAt: document.getElementById("updatedAt"),
  refreshButton: document.getElementById("refreshButton"),
  useLocationButton: document.getElementById("useLocationButton"),
  mapFrameLabel: document.getElementById("mapFrameLabel"),
  timelineButtons: Array.from(document.querySelectorAll(".meter-item")),
};

document.addEventListener("DOMContentLoaded", () => {
  setupMap();
  bindEvents();
  setupLocation();
  refreshWeather();
  state.refreshTimer = window.setInterval(refreshWeather, APP_CONFIG.refreshIntervalMs);
});

function setupMap() {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView(APP_CONFIG.center, APP_CONFIG.mapZoom);

  L.control
    .zoom({
      position: "bottomright",
    })
    .addTo(state.map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(state.map);
}

function bindEvents() {
  dom.refreshButton.addEventListener("click", () => {
    refreshWeather();
  });

  dom.useLocationButton.addEventListener("click", () => {
    requestUserLocation();
  });

  dom.timelineButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      setActiveFrame(index);
    });
  });
}

async function refreshWeather() {
  setStatus("RainViewerのデータを確認しています");
  dom.refreshButton.disabled = true;

  try {
    const response = await fetch(`${APP_CONFIG.rainViewerUrl}?_=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const frames = collectFrames(payload);

    if (!frames.length) {
      throw new Error("フレームが見つかりません");
    }

    state.frames = frames;
    state.frameHost = payload.host || "https://tilecache.rainviewer.com";
    state.tileCache.clear();

    const snapshots = await Promise.all(TIME_SLOTS.map((slot) => buildSnapshot(slot, frames, state.frameHost)));

    state.snapshots = snapshots;
    renderForecast(snapshots);
    setActiveFrame(state.activeIndex, true);
    setUpdatedTime(new Date());
  } catch (error) {
    console.error(error);
    renderErrorState();
  } finally {
    dom.refreshButton.disabled = false;
  }
}

function collectFrames(payload) {
  const pastFrames = (payload?.radar?.past || []).map((frame) => ({
    ...frame,
    kind: "past",
  }));

  const nowcastFrames = (payload?.radar?.nowcast || []).map((frame) => ({
    ...frame,
    kind: "nowcast",
  }));

  return [...pastFrames, ...nowcastFrames].sort((a, b) => a.time - b.time);
}

async function buildSnapshot(slot, frames, host) {
  const frame = pickFrameForTime(frames, slot.minutes);
  const signal = await analyzeFrame(frame, host);

  return {
    slot,
    frame,
    signal,
  };
}

function pickFrameForTime(frames, minutesAhead) {
  const nowSeconds = Date.now() / 1000;
  const targetSeconds = nowSeconds + minutesAhead * 60;

  const candidates =
    minutesAhead > 0
      ? frames.filter((frame) => frame.kind === "nowcast")
      : frames;

  const pool = candidates.length ? candidates : frames;

  return pool.reduce((best, frame) => {
    if (!best) {
      return frame;
    }

    const bestDiff = Math.abs(best.time - targetSeconds);
    const currentDiff = Math.abs(frame.time - targetSeconds);

    return currentDiff < bestDiff ? frame : best;
  }, null);
}

async function analyzeFrame(frame, host) {
  const analysis = getAnalysisPoints();
  const sampleResults = await Promise.all(
    analysis.points.map((point) => samplePointFromFrame(frame, host, point))
  );

  state.analysisMode = analysis.mode;

  if (analysis.mode === "current") {
    return pickSignalForCurrentLocation(sampleResults);
  }

  return pickSignalForRegion(sampleResults);
}

function getAnalysisPoints() {
  if (state.userLocation) {
    const { lat, lon } = state.userLocation;
    const offset = APP_CONFIG.locationClusterOffset;

    return {
      mode: "current",
      points: [
        { lat, lon },
        { lat: lat + offset, lon },
        { lat: lat - offset, lon },
        { lat, lon: lon + offset },
        { lat, lon: lon - offset },
      ],
    };
  }

  return {
    mode: "region",
    points: APP_CONFIG.regionSamples,
  };
}

function pickSignalForRegion(sampleResults) {
  const strongest = Math.max(...sampleResults.map((result) => result.rank));
  const mediumCount = sampleResults.filter((result) => result.rank >= 1).length;
  const strongCount = sampleResults.filter((result) => result.rank >= 2).length;

  if (strongest >= 2 && strongCount >= 1) {
    return "rain";
  }

  if (mediumCount >= 2) {
    return "soon";
  }

  return strongest >= 1 ? "soon" : "safe";
}

function pickSignalForCurrentLocation(sampleResults) {
  const [center, ...surroundings] = sampleResults;
  const nearbyWet = surroundings.filter((result) => result.rank >= 1).length;
  const nearbyStrong = surroundings.filter((result) => result.rank >= 2).length;

  if (center.rank >= 2) {
    return "rain";
  }

  if (center.rank >= 1 || nearbyStrong >= 1 || nearbyWet >= 2) {
    return "soon";
  }

  return "safe";
}

async function samplePointFromFrame(frame, host, point) {
  const { tileX, tileY, pixelX, pixelY } = latLonToTile(
    point.lat,
    point.lon,
    APP_CONFIG.analysisZoom
  );
  const canvas = await getTileCanvas(frame, host, APP_CONFIG.analysisZoom, tileX, tileY);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixel = context.getImageData(pixelX, pixelY, 1, 1).data;
  return classifyPixel(pixel);
}

function latLonToTile(lat, lon, zoom) {
  const scale = 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;

  const tileX = Math.floor(x);
  const tileY = Math.floor(y);

  return {
    tileX,
    tileY,
    pixelX: Math.max(0, Math.min(255, Math.floor((x - tileX) * 256))),
    pixelY: Math.max(0, Math.min(255, Math.floor((y - tileY) * 256))),
  };
}

async function getTileCanvas(frame, host, zoom, tileX, tileY) {
  const key = `${frame.path}-${zoom}-${tileX}-${tileY}`;

  if (state.tileCache.has(key)) {
    return state.tileCache.get(key);
  }

  const url = `${host}${frame.path}/256/${zoom}/${tileX}/${tileY}/2/0_0.png`;
  const response = await fetch(url, { cache: "force-cache" });

  if (response.status === 404) {
    const blankCanvas = createTransparentCanvas();
    state.tileCache.set(key, blankCanvas);
    return blankCanvas;
  }

  if (!response.ok) {
    throw new Error(`タイル取得失敗: ${response.status}`);
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, 256, 256);
  bitmap.close();

  state.tileCache.set(key, canvas);
  return canvas;
}

function createTransparentCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  return canvas;
}

function classifyPixel(pixel) {
  const [red, green, blue, alpha] = pixel;

  if (alpha < 20) {
    return SIGNAL_META.safe;
  }

  const warmth = red - blue;

  if ((red > 160 && green < 140) || alpha > 180 || warmth > 120) {
    return SIGNAL_META.rain;
  }

  if (green > 120 || red > 130 || alpha > 70) {
    return SIGNAL_META.soon;
  }

  return SIGNAL_META.safe;
}

function renderForecast(snapshots) {
  const pattern = choosePattern(snapshots);
  const avatar = AVATAR_PATTERNS[pattern];

  dom.avatarImage.src = avatar.image;
  dom.avatarComment.textContent = avatar.comment;
  setStatus(buildStatusLine(pattern, snapshots));
  renderLocationInfo(pattern, snapshots);

  dom.timelineButtons.forEach((button, index) => {
    const snapshot = snapshots[index];
    const dot = button.querySelector("[data-dot]");
    const caption = button.querySelector("[data-caption]");
    const signalMeta = SIGNAL_META[snapshot.signal];

    dot.className = `meter-dot ${signalMeta.className}`;
    caption.textContent = signalMeta.label;
  });
}

function choosePattern(snapshots) {
  const [now, thirty, sixty] = snapshots.map((snapshot) => snapshot.signal);
  const nowWet = now !== "safe";
  const futureWet = thirty !== "safe" || sixty !== "safe";

  if (!nowWet && !futureWet) {
    return "safe";
  }

  if (!nowWet && futureWet) {
    return "soonRain";
  }

  if (nowWet && sixty === "safe") {
    return "soonClear";
  }

  return "rain";
}

function buildStatusLine(pattern, snapshots) {
  const labels = snapshots.map((snapshot) => snapshot.slot.label).join(" / ");
  const target = state.analysisMode === "current" ? "現在地" : "大阪市内〜東大阪";

  switch (pattern) {
    case "safe":
      return `${target}は ${labels} を見ても大きな雨雲は近づいていません`;
    case "soonRain":
      return state.analysisMode === "current"
        ? "現在地は今は大丈夫ですが、このあと雨雲が近づく見込みです"
        : "今は大丈夫ですが、このあと大阪東側へ雨雲が近づく見込みです";
    case "soonClear":
      return state.analysisMode === "current"
        ? "現在地の雨は短めで、1時間後には落ち着く見込みです"
        : "いまの雨は短めで、1時間後には落ち着く見込みです";
    default:
      return state.analysisMode === "current"
        ? "現在地では、しばらく雨が続く見込みです"
        : "大阪市内から東大阪にかけて、しばらく雨が残る見込みです";
  }
}

function renderLocationInfo(pattern, snapshots) {
  if (state.userLocation) {
    dom.locationLabel.textContent = "現在地ピンポイント";
    dom.locationText.textContent = buildLocationLine(pattern, snapshots);
    dom.useLocationButton.textContent = "現在地を更新";
    return;
  }

  dom.locationLabel.textContent = "広域モード";
  dom.locationText.textContent = "現在地を使うと、この場所で雨が降るかどうかをピンポイントで見られます。";
  dom.useLocationButton.textContent = "現在地を使う";
}

function buildLocationLine(pattern, snapshots) {
  const timeSummary = snapshots
    .map((snapshot) => `${snapshot.slot.label} ${SIGNAL_META[snapshot.signal].label}`)
    .join(" / ");

  switch (pattern) {
    case "safe":
      return `現在地は ${timeSummary}。いまのところ傘なしで動けそうです。`;
    case "soonRain":
      return `現在地は ${timeSummary}。近いうちに降り始めそうです。`;
    case "soonClear":
      return `現在地は ${timeSummary}。この雨はもうすぐ抜けそうです。`;
    default:
      return `現在地は ${timeSummary}。しばらく雨を見込んだほうがよさそうです。`;
  }
}

function setActiveFrame(index, keepIfOutOfRange = false) {
  if (!state.snapshots.length) {
    return;
  }

  if (keepIfOutOfRange && !state.snapshots[index]) {
    index = 0;
  }

  if (!state.snapshots[index]) {
    return;
  }

  state.activeIndex = index;

  dom.timelineButtons.forEach((button, buttonIndex) => {
    button.classList.toggle("is-active", buttonIndex === index);
    button.setAttribute("aria-selected", String(buttonIndex === index));
  });

  const snapshot = state.snapshots[index];
  dom.mapFrameLabel.textContent = `地図: ${snapshot.slot.label}`;
  updateRadarLayer(snapshot.frame);
}

function updateRadarLayer(frame) {
  if (!state.map || !frame) {
    return;
  }

  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
  }

  state.radarLayer = L.tileLayer(
    `${state.frameHost}${frame.path}/256/{z}/{x}/{y}/2/0_0.png`,
    {
      opacity: 0.58,
      maxZoom: 18,
      errorTileUrl: TRANSPARENT_TILE_DATA_URL,
      attribution: '&copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
    }
  );

  state.radarLayer.addTo(state.map);
}

function renderErrorState() {
  dom.avatarImage.src = AVATAR_PATTERNS.error.image;
  dom.avatarComment.textContent = AVATAR_PATTERNS.error.comment;
  setStatus("地図は表示できますが、雨雲データの取得に失敗しました");
  dom.updatedAt.textContent = "最終更新: 取得失敗";
  dom.locationLabel.textContent = state.userLocation ? "現在地ピンポイント" : "広域モード";
  dom.locationText.textContent = "雨雲データを読めなかったため、いまは予測を更新できません。";

  dom.timelineButtons.forEach((button) => {
    const dot = button.querySelector("[data-dot]");
    const caption = button.querySelector("[data-caption]");
    dot.className = "meter-dot dot-soon";
    caption.textContent = "確認待ち";
  });
}

function setStatus(text) {
  dom.statusText.textContent = text;
}

function setUpdatedTime(date) {
  const time = date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
  dom.updatedAt.textContent = `最終更新: ${time}`;
}

function setupLocation() {
  if (!("geolocation" in navigator)) {
    dom.locationText.textContent = "この端末では現在地が使えないため、広域の雨雲情報を表示しています。";
    dom.useLocationButton.disabled = true;
    return;
  }

  if ("permissions" in navigator && navigator.permissions?.query) {
    navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (result.state === "granted") {
          requestUserLocation(false);
        }
      })
      .catch(() => {
        // 何もしない
      });
  }
}

function requestUserLocation(showLoading = true) {
  if (!("geolocation" in navigator)) {
    return;
  }

  dom.useLocationButton.disabled = true;

  if (showLoading) {
    dom.locationLabel.textContent = "現在地ピンポイント";
    dom.locationText.textContent = "現在地を取得しています…";
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userLocation = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      dom.useLocationButton.disabled = false;
      refreshWeather();
    },
    () => {
      dom.useLocationButton.disabled = false;
      dom.locationLabel.textContent = "広域モード";
      dom.locationText.textContent = "現在地が取得できなかったため、大阪の広域予測を表示しています。";
    },
    {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 10 * 60 * 1000,
    }
  );
}
