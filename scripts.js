// ============================
// AIRSNIFFER MK1
// ============================

const API_BASE = "https://airsniffer-api.onrender.com";
const LAT = -29.1734;
const LON = -54.8635;

// Variáveis globais
let historyChartInstance = null;
let currentData = {
    indoor: null,
    outdoor: null,
    history: []
};

// Gerenciador de cache
class DataManager {
    constructor() {
        this.cache = new Map();
        this.cacheTimeout = 30000;
    }

    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() - item.timestamp > this.cacheTimeout) {
            this.cache.delete(key);
            return null;
        }
        
        return item.data;
    }

    clear() {
        this.cache.clear();
    }
}

const dataManager = new DataManager();

// -----------------------
// FUNÇÕES DE CLASSIFICAÇÃO AQI
// -----------------------

function classifyAQIByTVOC(tvoc_ppb) {
    if (tvoc_ppb === null || tvoc_ppb === undefined) return 3;
    
    // Classificação específica para TVOC (em ppb) - Valores REAIS dos sensores
    if (tvoc_ppb <= 220) return 1;        // Excelente (0-220 ppb)
    else if (tvoc_ppb <= 660) return 2;   // Bom (221-660 ppb)
    else if (tvoc_ppb <= 2200) return 3;  // Moderado (661-2200 ppb)
    else if (tvoc_ppb <= 5500) return 4;  // Ruim (2201-5500 ppb)
    else return 5;                        // Péssimo (>5500 ppb)
}

function classifyAQIByCO2(co2_ppm) {
    if (co2_ppm === null || co2_ppm === undefined) return 3;
    
    // Classificação específica para CO2 (em ppm) - Valores REAIS dos sensores
    if (co2_ppm <= 600) return 1;        // Excelente (0-600 ppm)
    else if (co2_ppm <= 800) return 2;   // Bom (601-800 ppm)
    else if (co2_ppm <= 1000) return 3;  // Moderado (801-1000 ppm)
    else if (co2_ppm <= 1500) return 4;  // Ruim (1001-1500 ppm)
    else return 5;                       // Péssimo (>1500 ppm)
}

// Função principal que calcula o AQI geral baseado em todos os sensores
function calculateOverallAQI(data) {
    if (!data) return 3;
    
    const tvocAQI = classifyAQIByTVOC(data.tvoc_ppb);
    const co2AQI = classifyAQIByCO2(data.co2_ppm);
    
    // Calcular média ponderada (CO2 tem mais peso por ser mais crítico)
    const overallAQI = Math.round((co2AQI * 0.6) + (tvocAQI * 0.4));
    
    // Garantir que seja inteiro entre 1-5
    return Math.max(1, Math.min(5, overallAQI));
}

function classifyOutdoorAQI(data) {
    if (!data) return 3;
    
    let aqiLevel = 3;
    
    if (data.usAqi) {
        if (data.usAqi <= 50) aqiLevel = 1;
        else if (data.usAqi <= 100) aqiLevel = 2;
        else if (data.usAqi <= 150) aqiLevel = 3;
        else if (data.usAqi <= 200) aqiLevel = 4;
        else aqiLevel = 5;
    } else if (data.pm25) {
        if (data.pm25 <= 12) aqiLevel = 1;
        else if (data.pm25 <= 35.5) aqiLevel = 2;
        else if (data.pm25 <= 55.5) aqiLevel = 3;
        else if (data.pm25 <= 150.5) aqiLevel = 4;
        else aqiLevel = 5;
    }
    
    // Garantir que seja inteiro
    return Math.max(1, Math.min(5, aqiLevel));
}

function calculateAQIPercentage(level) {
    return Math.max(10, level * 20); // 1=20%, 2=40%, 3=60%, 4=80%, 5=100%
}

function aqiLevelToText(level) {
    const texts = {
        1: "EXCELENTE",
        2: "BOM",
        3: "MODERADO",
        4: "RUIM", 
        5: "PÉSSIMO"
    };
    
    return texts[level] || "MODERADO";
}

function getAQIColor(level) {
    const colors = {
        1: "#00c853", // Verde - Excelente
        2: "#64dd17", // Verde claro - Bom
        3: "#ffd600", // Amarelo - Moderado
        4: "#ff9100", // Laranja - Ruim
        5: "#ff3d00"  // Vermelho - Péssimo
    };
    
    return colors[level] || "#ffd600";
}

// -----------------------
// FUNÇÕES DE API
// -----------------------

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

async function fetchLatestIndoorData() {
    const cacheKey = 'indoor_latest';
    const cached = dataManager.get(cacheKey);
    if (cached) return cached;
    
    try {
        const data = await fetchWithTimeout(`${API_BASE}/sensores`);
        
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('Nenhum dado disponível');
        }

        const latest = data[0];
        currentData.indoor = latest;
        
        updateIndoorUI(latest);
        
        dataManager.set(cacheKey, latest);
        return latest;

    } catch (error) {
        console.warn("Erro ao buscar dados internos:", error.message);
        showErrorState('.indoor-card', "Dados indisponíveis");
        return null;
    }
}

async function fetchHistory(hours = 24) {
    const cacheKey = `history_${hours}`;
    const cached = dataManager.get(cacheKey);
    if (cached) {
        updateHistoryChart(cached, hours);
        return cached;
    }
    
    try {
        const data = await fetchWithTimeout(`${API_BASE}/historico?horas=${hours}`);
        
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('Nenhum histórico disponível');
        }

        currentData.history = data;
        updateHistoryChart(data, hours);
        
        dataManager.set(cacheKey, data);
        return data;

    } catch (error) {
        console.warn("Erro ao buscar histórico:", error.message);
        return null;
    }
}

async function fetchOutdoorData() {
    const cacheKey = 'outdoor_current';
    const cached = dataManager.get(cacheKey);
    if (cached) return cached;
    
    try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,weather_code&timezone=America/Sao_Paulo`;
        const weatherData = await fetchWithTimeout(weatherUrl);
        
        const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&current=pm2_5,pm10,us_aqi&timezone=America/Sao_Paulo`;
        const airData = await fetchWithTimeout(airUrl);
        
        const outdoorData = {
            temperature: weatherData.current?.temperature_2m ?? null,
            humidity: weatherData.current?.relative_humidity_2m ?? null,
            pressure: weatherData.current?.surface_pressure ?? null,
            windSpeed: weatherData.current?.wind_speed_10m ?? null,
            weatherCode: weatherData.current?.weather_code ?? null,
            pm25: airData.current?.pm2_5 ?? null,
            pm10: airData.current?.pm10 ?? null,
            usAqi: airData.current?.us_aqi ?? null
        };
        
        currentData.outdoor = outdoorData;
        updateOutdoorUI(outdoorData);
        
        dataManager.set(cacheKey, outdoorData);
        return outdoorData;

    } catch (error) {
        console.warn("Erro ao buscar dados externos:", error.message);
        showErrorState('.outdoor-card', "Dados externos indisponíveis");
        return null;
    }
}

// -----------------------
//  UI
// -----------------------

function updateIndoorUI(data) {
    if (!data) return;
    
    const aqiLevel = calculateOverallAQI(data);
    const aqiPercentage = calculateAQIPercentage(aqiLevel);
    const aqiText = aqiLevelToText(aqiLevel);
    const aqiColor = getAQIColor(aqiLevel);
    
    console.log('Dados Indoor:', {
        co2: data.co2_ppm,
        tvoc: data.tvoc_ppb,
        aqiCalculado: aqiLevel,
        co2AQI: classifyAQIByCO2(data.co2_ppm),
        tvocAQI: classifyAQIByTVOC(data.tvoc_ppb)
    });
    
    // Atualizar card principal
    safeUpdateElement("#indoor-aqi-value", aqiLevel);
    safeUpdateElement("#indoor-aqi-label", aqiText);
    safeUpdateElement(".indoor-temp", data.temperature?.toFixed(1));
    safeUpdateElement(".indoor-hum", data.humidity?.toFixed(1));
    
    // Atualizar métricas
    safeUpdateElement("#co2-value", `${data.co2_ppm} ppm`);
    safeUpdateElement("#tvoc-value", `${data.tvoc_ppb} ppb`);
    safeUpdateElement("#air-value", aqiText);
    
    // Atualizar detalhes
    safeUpdateElement("#detail-co2", `${data.co2_ppm} ppm`);
    safeUpdateElement("#detail-tvoc", `${data.tvoc_ppb} ppb`);
    safeUpdateElement("#detail-temp", `${data.temperature?.toFixed(1)} °C`);
    safeUpdateElement("#detail-hum", `${data.humidity?.toFixed(1)} %`);
    safeUpdateElement("#last-update", new Date().toLocaleTimeString());
    
    // Atualizar círculo de progresso
    updateCircularProgress('indoor-progress', aqiPercentage, aqiColor);
    
    // Atualizar cores dos cards
    updateCardColors('.indoor-card', aqiLevel);
}

function updateOutdoorUI(data) {
    if (!data) return;
    
    const aqiLevel = classifyOutdoorAQI(data);
    const aqiPercentage = calculateAQIPercentage(aqiLevel);
    const aqiText = aqiLevelToText(aqiLevel);
    const aqiColor = getAQIColor(aqiLevel);
    
    console.log('Dados Outdoor:', {
        usAqi: data.usAqi,
        pm25: data.pm25,
        aqiCalculado: aqiLevel
    });
    
    // Atualizar card principal
    safeUpdateElement("#outdoor-aqi-value", aqiLevel);
    safeUpdateElement("#outdoor-aqi-label", aqiText);
    safeUpdateElement(".outdoor-temp", data.temperature?.toFixed(1));
    safeUpdateElement(".outdoor-hum", data.humidity?.toFixed(0));
    
    // Atualizar informações meteorológicas
    safeUpdateElement("#weather-condition", getWeatherCondition(data.weatherCode));
    safeUpdateElement("#weather-wind", `${data.windSpeed?.toFixed(1) ?? "--"} km/h`);
    safeUpdateElement("#weather-pressure", `${data.pressure?.toFixed(0) ?? "--"} hPa`);
    safeUpdateElement("#weather-visibility", "10 km");
    
    // Atualizar ícone do clima
    updateWeatherIcon(data.weatherCode);
    
    // Atualizar detalhes
    safeUpdateElement("#detail-outdoor-aqi", data.usAqi ?? "--");
    safeUpdateElement("#detail-pm25", `${data.pm25?.toFixed(1) ?? "--"} μg/m³`);
    safeUpdateElement("#detail-pm10", `${data.pm10?.toFixed(1) ?? "--"} μg/m³`);
    
    // Atualizar círculo de progresso
    updateCircularProgress('outdoor-progress', aqiPercentage, aqiColor);
    
    // Atualizar cores dos cards
    updateCardColors('.outdoor-card', aqiLevel);
}

function updateWeatherIcon(weatherCode) {
    const iconElement = document.getElementById('weather-icon');
    if (!iconElement) return;
    
    const icons = {
        0: '☀️',  // Clear sky
        1: '🌤️',  // Mainly clear
        2: '⛅',  // Partly cloudy
        3: '☁️',  // Overcast
        45: '🌫️', // Fog
        48: '🌫️', // Depositing rime fog
        51: '🌦️', // Drizzle light
        53: '🌦️', // Drizzle moderate
        55: '🌦️', // Drizzle dense
        61: '🌧️', // Rain slight
        63: '🌧️', // Rain moderate
        65: '🌧️', // Rain heavy
        80: '🌦️', // Rain showers slight
        81: '🌦️', // Rain showers moderate
        82: '🌦️', // Rain showers violent
        95: '⛈️',  // Thunderstorm
        96: '⛈️',  // Thunderstorm with hail
        99: '⛈️'   // Thunderstorm with heavy hail
    };
    
    iconElement.textContent = icons[weatherCode] || '🌤️';
}

// -----------------------
// GRÁFICO DE HISTÓRICO
// -----------------------

function initializeHistoryChart() {
    if (typeof Chart === 'undefined') {
        console.error('Chart.js não foi carregado!');
        return;
    }
    
    const ctx = document.getElementById('historyChart');
    if (!ctx) {
        console.error('Canvas do gráfico não encontrado');
        return;
    }
    
    try {
        historyChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'AQI Interno',
                        data: [],
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        borderWidth: 3,
                        tension: 0.4,
                        fill: true,
                        pointBackgroundColor: '#8b5cf6',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        pointRadius: 3,
                        pointHoverRadius: 5
                    },
                    {
                        label: 'AQI Externo',
                        data: [],
                        borderColor: '#f97316',
                        backgroundColor: 'rgba(249, 115, 22, 0.1)',
                        borderWidth: 3,
                        tension: 0.4,
                        fill: true,
                        pointBackgroundColor: '#f97316',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        pointRadius: 3,
                        pointHoverRadius: 5
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: 'rgba(255, 255, 255, 0.9)',
                            font: {
                                size: 12,
                                family: "'Poppins', sans-serif"
                            },
                            padding: 15,
                            usePointStyle: true,
                            boxWidth: 6
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 26, 42, 0.95)',
                        titleColor: 'rgba(255, 255, 255, 0.95)',
                        bodyColor: 'rgba(255, 255, 255, 0.85)',
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true,
                        padding: 12,
                        usePointStyle: true,
                        callbacks: {
                            title: function(tooltipItems) {
                                const dataIndex = tooltipItems[0].dataIndex;
                                const datasetIndex = tooltipItems[0].datasetIndex;
                                
                                if (datasetIndex === 0 && currentData.history && currentData.history[dataIndex]) {
                                    const originalDate = new Date(currentData.history[dataIndex].created_at);
                                    return formatDateTime(originalDate);
                                }
                                
                                const label = tooltipItems[0].label;
                                if (label) {
                                    const now = new Date();
                                    return `${now.toLocaleDateString('pt-BR')} ${label}`;
                                }
                                
                                return new Date().toLocaleString('pt-BR');
                            },
                            label: function(context) {
                                const value = context.parsed.y;
                                const intValue = Math.round(value);
                                const labels = ['', 'Excelente (1)', 'Bom (2)', 'Moderado (3)', 'Ruim (4)', 'Péssimo (5)'];
                                
                                let extraInfo = '';
                                if (context.datasetIndex === 0 && currentData.history && currentData.history[context.dataIndex]) {
                                    const dataPoint = currentData.history[context.dataIndex];
                                    extraInfo = ` | CO₂: ${dataPoint.co2_ppm}ppm | TVOC: ${dataPoint.tvoc_ppb}ppb`;
                                } else if (context.datasetIndex === 1 && currentData.outdoor) {
                                    extraInfo = ` | PM2.5: ${currentData.outdoor.pm25?.toFixed(1) || '--'}μg/m³`;
                                }
                                
                                return `${context.dataset.label}: ${labels[intValue] || intValue}${extraInfo}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)',
                            font: {
                                size: 11,
                                family: "'Poppins', sans-serif"
                            },
                            maxTicksLimit: 8,
                            callback: function(value, index, values) {
                                const label = this.getLabelForValue(value);
                                if (!label) return '';
                                
                                if (label.includes('/') || label.includes(':')) {
                                    return label;
                                }
                                
                                const hours = parseInt(document.querySelector('.time-btn.active')?.dataset.period || '24');
                                if (hours > 24) {
                                    const now = new Date();
                                    const date = new Date(now.getTime() - (values.length - 1 - index) * (hours * 60 * 60 * 1000 / values.length));
                                    return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
                                }
                                
                                return label;
                            }
                        },
                        title: {
                            display: true,
                            text: 'Data e Hora',
                            color: 'rgba(255, 255, 255, 0.8)',
                            font: {
                                size: 12,
                                weight: '600',
                                family: "'Poppins', sans-serif"
                            },
                            padding: { top: 10, bottom: 5 }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        min: 0.5,
                        max: 5.5,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)',
                            font: {
                                size: 11,
                                family: "'Poppins', sans-serif"
                            },
                            stepSize: 1,
                            padding: 8,
                            // Forçar valores inteiros no eixo Y
                            callback: function(value) {
                                const intValue = Math.round(value);
                                const labels = {
                                    1: 'Excelente',
                                    2: 'Bom', 
                                    3: 'Moderado',
                                    4: 'Ruim',
                                    5: 'Péssimo'
                                };
                                return labels[intValue] || '';
                            }
                        },
                        title: {
                            display: true,
                            text: 'Qualidade do Ar (AQI)',
                            color: 'rgba(255, 255, 255, 0.8)',
                            font: {
                                size: 12,
                                weight: '600',
                                family: "'Poppins', sans-serif"
                            },
                            padding: { top: 5, bottom: 10 }
                        }
                    }
                },
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart'
                }
            }
        });
        
        window.historyChartInstance = historyChartInstance;
        
    } catch (error) {
        console.error('Erro ao inicializar gráfico:', error);
    }
}

function updateHistoryChart(historyData, hours) {
    if (!historyChartInstance || !historyData || !historyData.length) {
        return;
    }
    
    try {
        const maxPoints = getMaxPointsForInterval(hours);
        const slicedData = historyData.slice(-maxPoints);
        
        const labels = createTimeLabels(slicedData, hours);

        historyChartInstance.data.labels = labels;
        historyChartInstance.data.datasets[0].data = slicedData.map(d => calculateOverallAQI(d));
        
        const currentOutdoorAQI = classifyOutdoorAQI(currentData.outdoor);
        historyChartInstance.data.datasets[1].data = createOutdoorData(slicedData.length, currentOutdoorAQI);
        
        currentData.history = slicedData;
        
        updateQuickMetrics(slicedData);
        
        historyChartInstance.update('none');
        
    } catch (error) {
        console.error('Erro ao atualizar gráfico:', error);
    }
}

function createTimeLabels(data, hours) {
    return data.map((d, index) => {
        const date = new Date(d.created_at);
        const totalPoints = data.length;
        
        if (hours <= 6) {
            if (totalPoints <= 8 || index % Math.ceil(totalPoints / 6) === 0 || index === totalPoints - 1) {
                return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            }
        } else if (hours <= 24) {
            if (index % Math.ceil(totalPoints / 8) === 0 || index === totalPoints - 1) {
                return `${date.getHours().toString().padStart(2, '0')}h`;
            }
        } else {
            if (index % Math.ceil(totalPoints / 7) === 0 || index === totalPoints - 1) {
                return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}h`;
            }
        }
        
        return '';
    });
}

function formatDateTime(date) {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    
    return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function createOutdoorData(length, currentAQI) {
    return Array.from({ length }, (_, i) => {
        const baseVariation = Math.sin(i * 0.3) * 0.4;
        const randomVariation = (Math.random() * 0.3 - 0.15);
        const totalVariation = baseVariation + randomVariation;
        
        let variedAQI = currentAQI + totalVariation;
        variedAQI = Math.round(variedAQI);
        variedAQI = Math.max(1, Math.min(5, variedAQI));
        
        return variedAQI;
    });
}

// -----------------------
// FUNÇÕES AUXILIARES
// -----------------------

function getWeatherCondition(weatherCode) {
    const conditions = {
        0: "Céu limpo",
        1: "Poucas nuvens", 
        2: "Parcialmente nublado",
        3: "Nublado",
        45: "Nevoeiro",
        48: "Nevoeiro",
        51: "Chuvisco",
        53: "Chuvisco moderado",
        55: "Chuvisco forte",
        61: "Chuva leve",
        63: "Chuva moderada",
        65: "Chuva forte",
        80: "Pancadas de chuva",
        81: "Pancadas fortes",
        82: "Pancadas violentas",
        95: "Tempestade",
        96: "Tempestade com granizo",
        99: "Tempestade forte"
    };
    
    return conditions[weatherCode] || "Condição desconhecida";
}

function getMaxPointsForInterval(hours) {
    switch(parseInt(hours)) {
        case 6: return 36;
        case 12: return 72;
        case 24: return 144;
        case 168: return 168;
        default: return 144;
    }
}

function safeUpdateElement(selector, value) {
    try {
        const element = document.querySelector(selector);
        if (element) {
            element.textContent = value !== undefined && value !== null ? value : '--';
        }
    } catch (error) {
        console.warn('Erro ao atualizar elemento:', selector, error);
    }
}

function updateCircularProgress(circleId, percentage, color) {
    try {
        const circle = document.getElementById(circleId);
        const valueElement = document.getElementById(circleId.replace('progress', 'aqi-value'));
        
        if (circle && valueElement) {
            const circumference = 2 * Math.PI * 90;
            const offset = circumference - (percentage / 100) * circumference;
            
            circle.style.strokeDashoffset = offset;
            circle.style.stroke = color;
            valueElement.style.color = color;
        }
    } catch (error) {
        console.warn('Erro ao atualizar progresso circular:', error);
    }
}

function updateCardColors(selector, aqiLevel) {
    try {
        const card = document.querySelector(selector);
        if (card) {
            const colors = {
                1: 'status-excellent',
                2: 'status-good', 
                3: 'status-moderate',
                4: 'status-poor',
                5: 'status-poor'
            };
            
            card.className = card.className.replace(/\bstatus-\w+/g, '');
            card.classList.add(colors[aqiLevel] || 'status-moderate');
        }
    } catch (error) {
        console.warn('Erro ao atualizar cores do card:', error);
    }
}

function showErrorState(selector, message) {
    try {
        const card = document.querySelector(selector);
        if (card) {
            const statusElement = card.querySelector('.aqi-label');
            const valueElement = card.querySelector('.aqi-value');
            
            if (statusElement) {
                statusElement.textContent = message;
                statusElement.style.color = '#f56565';
            }
            
            if (valueElement) {
                valueElement.textContent = "---";
            }
        }
    } catch (error) {
        console.warn('Erro ao mostrar estado de erro:', error);
    }
}

function updateQuickMetrics(historyData) {
    if (!historyData || historyData.length === 0) return;

    try {
        const temps = historyData.map(d => d.temperature).filter(t => t != null);
        const hums = historyData.map(d => d.humidity).filter(h => h != null);
        const aqis = historyData.map(d => calculateOverallAQI(d));
        
        const avgTemp = temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : '--';
        const avgHumidity = hums.length ? (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1) : '--';
        const peakAQI = aqis.length ? Math.max(...aqis) : '--';
        
        const avgAQI = aqis.length ? aqis.reduce((a, b) => a + b, 0) / aqis.length : 0;
        const airQuality = avgAQI <= 2 ? "Boa" : avgAQI <= 3 ? "Moderada" : "Ruim";

        safeUpdateElement('#avgTemp', `${avgTemp}°C`);
        safeUpdateElement('#avgHumidity', `${avgHumidity}%`);
        safeUpdateElement('#peakAQI', peakAQI);
        safeUpdateElement('#airQuality', airQuality);
    } catch (error) {
        console.warn('Erro ao atualizar métricas rápidas:', error);
    }
}

// -----------------------
// GERENCIAMENTO PRINCIPAL
// -----------------------

async function updateAllData() {
    try {
        document.body.classList.add('loading');
        
        const interval = document.querySelector('.time-btn.active')?.dataset.period || '24';
        
        await Promise.allSettled([
            fetchLatestIndoorData(),
            fetchHistory(interval),
            fetchOutdoorData()
        ]);
        
        safeUpdateElement('#connection-status', '✓ Conectado');
        
    } catch (error) {
        console.error('Erro na atualização:', error);
        safeUpdateElement('#connection-status', '⚠️ Offline');
    } finally {
        document.body.classList.remove('loading');
    }
}

function startAutoRefresh() {
    setInterval(updateAllData, 60000); // 1 minuto
    setInterval(() => dataManager.clear(), 300000); // 5 minutos
}

// -----------------------
// EVENT LISTENERS
// -----------------------

function setupEventListeners() {
    // Toggle dos detalhes
    const indoorToggle = document.getElementById('indoor-details-toggle');
    const outdoorToggle = document.getElementById('outdoor-details-toggle');
    
    if (indoorToggle) {
        indoorToggle.addEventListener('click', function() {
            const content = document.getElementById('indoor-details');
            const arrow = document.getElementById('indoor-arrow');
            if (content && arrow) {
                content.classList.toggle('expanded');
                arrow.textContent = content.classList.contains('expanded') ? '▲' : '▼';
            }
        });
    }
    
    if (outdoorToggle) {
        outdoorToggle.addEventListener('click', function() {
            const content = document.getElementById('outdoor-details');
            const arrow = document.getElementById('outdoor-arrow');
            if (content && arrow) {
                content.classList.toggle('expanded');
                arrow.textContent = content.classList.contains('expanded') ? '▲' : '▼';
            }
        });
    }

    // Seletor de tempo
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            fetchHistory(parseInt(this.dataset.period));
        });
    });

    // Atualizar quando a página ganha foco
    document.addEventListener("visibilitychange", function() {
        if (!document.hidden) {
            updateAllData();
        }
    });
}

// -----------------------
// INICIALIZAÇÃO
// -----------------------

function initializeApp() {
    console.log('Inicializando AirSniffer Mk1...');
    
    // Configurar ano atual
    safeUpdateElement("#current-year", new Date().getFullYear());
    
    // Inicializar sistemas
    setupEventListeners();
    
    // Inicializar gráfico
    setTimeout(() => {
        initializeHistoryChart();
        
        // Primeira carga de dados
        setTimeout(() => {
            updateAllData();
            startAutoRefresh();
        }, 1000);
    }, 500);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}