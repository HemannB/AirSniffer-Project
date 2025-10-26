// ============================
// AirSniffer Mk1 Dashboard JS
// ============================

const API_BASE = "https://airsniffer-api.onrender.com";
const LAT = -29.1734;
const LON = -54.8635;

// Chart.js Defaults
Chart.defaults.color = "#b0b0b0";
Chart.defaults.borderColor = "#404040";

// -----------------------
// Gráficos
// -----------------------
const tempHumidityCtx = document.getElementById("tempHumidityChart").getContext("2d");
const aqiCtx = document.getElementById("aqiChart").getContext("2d");

const tempHumidityChart = new Chart(tempHumidityCtx, {
  type: "line",
  data: { labels: [], datasets: [
    { label: "Temperatura (°C)", data: [], borderColor: "#ff9f43", tension: 0.4, fill: false },
    { label: "Umidade (%)", data: [], borderColor: "#4facfe", tension: 0.4, fill: false }
  ]},
  options: { responsive: true, maintainAspectRatio: false }
});

const aqiChart = new Chart(aqiCtx, {
  type: "line",
  data: { labels: [], datasets: [
    { label: "AQI Interior", data: [], borderColor: "#4facfe", tension: 0.4, fill: false },
    { label: "AQI Exterior", data: [], borderColor: "#43e97b", tension: 0.4, fill: false }
  ]},
  options: { responsive: true, maintainAspectRatio: false }
});

// -----------------------
// Funções de Atualização
// -----------------------
async function fetchLatest() {
  try {
    const res = await fetch(`${API_BASE}/sensores`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return;

    const latest = data[0];

    document.querySelector(".indoor-card .aqi-value").textContent = classifyAQI(latest.tvoc_ppb);
    document.querySelector(".indoor-card .aqi-status").textContent = aqiLevelToText(classifyAQI(latest.tvoc_ppb));
    document.querySelector(".indoor-card .aqi-description").textContent =
      `CO₂: ${latest.co2_ppm} ppm | VOC: ${(latest.tvoc_ppb/1000).toFixed(2)} mg/m³ | AQI: ${latest.aqi}`;

    document.querySelector(".indoor-temp").textContent = latest.temperature.toFixed(1);
    document.querySelector(".indoor-hum").textContent = latest.humidity.toFixed(1);

  } catch (err) {
    console.error("Erro ao buscar dados atuais:", err);
  }
}

async function fetchHistory(hours = 24) {
  try {
    const res = await fetch(`${API_BASE}/historico?horas=${hours}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return;

    const labels = data.map(d => {
      const dt = new Date(d.created_at);
      return `${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
    });

    const temps = data.map(d => d.temperature);
    const hums = data.map(d => d.humidity);
    const aqisIndoor = data.map(d => d.aqi);

    tempHumidityChart.data.labels = labels;
    tempHumidityChart.data.datasets[0].data = temps;
    tempHumidityChart.data.datasets[1].data = hums;
    tempHumidityChart.update();

    aqiChart.data.labels = labels;
    aqiChart.data.datasets[0].data = aqisIndoor;
    // AQI Exterior será atualizado dinamicamente
    aqiChart.update();

  } catch (err) {
    console.error("Erro ao buscar histórico:", err);
  }
}

// -----------------------
// Outdoor Open-Meteo
// -----------------------
async function fetchOutdoorData() {
  try {
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current_weather=true`);
    const weatherData = await weatherRes.json();
    const outdoorTemp = weatherData.current_weather?.temperature ?? null;
    const outdoorHum = weatherData.current_weather?.windspeed ?? null;

    const airRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&current=pm2_5,us_aqi`);
    const airData = await airRes.json();
    const pm25 = airData.current?.pm2_5 ?? null;
    const usAqi = airData.current?.us_aqi ?? null;

    const aqiLevel = classifyAQI(pm25 ?? 0);
    const aqiText = aqiLevelToText(aqiLevel);

    document.querySelector(".outdoor-card .aqi-value").textContent = aqiLevel;
    document.querySelector(".outdoor-card .aqi-status").textContent = aqiText;
    document.querySelector(".outdoor-card .aqi-description").textContent =
      `PM2.5: ${pm25?.toFixed(1) ?? "—"} μg/m³ | US AQI: ${usAqi ?? "—"}`;
    document.querySelector(".outdoor-temp").textContent = outdoorTemp?.toFixed(1) ?? "—";
    document.querySelector(".outdoor-hum").textContent = outdoorHum?.toFixed(1) ?? "—";

    if (aqiChart.data.datasets.length > 1) {
      aqiChart.data.datasets[1].data.push(aqiLevel);
      aqiChart.data.labels.push(new Date().getHours().toString().padStart(2,'0') + ":" + new Date().getMinutes().toString().padStart(2,'0'));
      if (aqiChart.data.datasets[1].data.length > 168) {
        aqiChart.data.datasets[1].data.shift();
        aqiChart.data.labels.shift();
      }
      aqiChart.update();
    }

  } catch (err) {
    console.error("Erro ao buscar dados externos:", err);
  }
}

// -----------------------
// AQI Helpers
// -----------------------
function classifyAQI(value) {
  if (value <= 12) return 1;
  if (value <= 35.5) return 2;
  if (value <= 55.5) return 3;
  if (value <= 150.5) return 4;
  return 5;
}

function aqiLevelToText(level) {
  switch(level) {
    case 1: return "Bom";
    case 2: return "Moderado";
    case 3: return "Ruim";
    case 4: return "Muito Ruim";
    case 5: return "Perigoso";
    default: return "Desconhecido";
  }
}

// -----------------------
// Listeners & Intervalos
// -----------------------
document.getElementById("intervalSelect").addEventListener("change", e => {
  fetchHistory(e.target.value);
});

window.addEventListener("load", () => {
  fetchLatest();
  fetchHistory();
  fetchOutdoorData();
});

// Atualiza a cada minuto
setInterval(() => {
  fetchLatest();
  fetchHistory();
  fetchOutdoorData();
}, 60000);

// -----------------------
// Rodapé dinâmico
// -----------------------
document.getElementById("year").innerText = new Date().getFullYear();
