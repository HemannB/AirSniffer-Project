/* AirSniffer
    -- Projeto Integador IV // Integrated Project IV
    -- Autor // Author: Bruno Hemann
    -- Orientador // Advisor: Prof. Me. Laurence Crestani Tasca
*/

/* ========== INCLUDES ========== */
#include <TFT_eSPI.h>
#include <Wire.h>
#include <SparkFun_ENS160.h>
#include <SparkFun_Qwiic_Humidity_AHT20.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* =========================
   ======== CONSTANTS ======
   ========================= */
namespace Config {
    // Sampling / UI
    const unsigned long ulSAMPLE_INTERVAL_MS = 2000;      // sensor read interval (ms)
    const unsigned long ulDISPLAY_UPDATE_MS = 2000;      // display update interval (ms)
    const unsigned long ulSCREEN_CHANGE_MS = 5000;       // rotate screens interval (ms)
    const unsigned long ulDATA_FRESH_THRESHOLD_MS = 15000;

    const int iSAMPLE_BUFFER_SIZE = 5;    // internal smoothing buffer (samples)
    const float fSMOOTHING_ALPHA = 0.3f;
    const int iTOTAL_SCREENS = 2;

    // Send-to-cloud buffering (amortization)
    const unsigned long ulSEND_INTERVAL_MS = 60000;  // how often to send averaged data (ms) - default 60s
    const int iSEND_BUFFER_SAMPLES = 12;             // number of samples to average between sends

    // Air-quality scales (unchanged)
    namespace Scales {
        const int iCO2_EXCELLENT = 400;
        const int iCO2_GOOD = 800;
        const int iCO2_MODERATE = 1200;
        const int iCO2_POOR = 2000;
        const int iCO2_HAZARDOUS = 5000;

        const int iTVOC_EXCELLENT = 50;
        const int iTVOC_GOOD = 200;
        const int iTVOC_MODERATE = 500;
        const int iTVOC_POOR = 1000;
        const int iTVOC_HAZARDOUS = 2500;
    }
}

/* =========================
   ======= UTILITIES =======
   ========================= */
namespace Utils {
    uint16_t CreateColorBGR(uint8_t r, uint8_t g, uint8_t b) {
        return ((b & 0xF8) << 8) | ((g & 0xFC) << 3) | (r >> 3);
    }

    int ConstrainMap(int value, int inMin, int inMax, int outMin, int outMax) {
        return constrain(map(value, inMin, inMax, outMin, outMax), outMin, outMax);
    }
}

/* =========================
   ======= DATA TYPES ======
   ========================= */
struct SensorData {
    float fTemperature = NAN;
    float fHumidity = NAN;
    int iAQI = 0;
    int iECO2 = 0;
    int iTVOC = 0;
    int iToxicLevel = 0;
    bool bTempHumValid = false;
    bool bENS160Valid = false;
};

struct SensorBuffers {
    float arrfTemperature[Config::iSAMPLE_BUFFER_SIZE];
    float arrfHumidity[Config::iSAMPLE_BUFFER_SIZE];
    int arriAQI[Config::iSAMPLE_BUFFER_SIZE];
    int arriECO2[Config::iSAMPLE_BUFFER_SIZE];
    int arriTVOC[Config::iSAMPLE_BUFFER_SIZE];
    int arriToxicLevel[Config::iSAMPLE_BUFFER_SIZE];
    int iIndex = 0;
    SensorBuffers() {
        for (int i=0;i<Config::iSAMPLE_BUFFER_SIZE;i++) {
            arrfTemperature[i] = 0.0f;
            arrfHumidity[i] = 0.0f;
            arriAQI[i] = 0;
            arriECO2[i] = 0;
            arriTVOC[i] = 0;
            arriToxicLevel[i] = 0;
        }
    }
};

/* =========================
   ====== PIN SETTINGS =====
   ========================= */
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22
#define MQ135_PIN 34

/* =========================
   ======= WIFI / CLOUD ====
   ========================= */
const char* pszWiFiSSID = "Josiel_Net";
const char* pszWiFiPass = "97179431";
const char* pszServerUrl = "https://airsniffer-api.onrender.com/sensores";

/* =========================
   ======= GLOBALS =========
   ========================= */
TFT_eSPI g_tft;
SparkFun_ENS160 g_ens160;
AHT20 g_aht20;

SensorBuffers g_sensorBuffers;
SensorData g_currentData;
SensorData g_smoothedData;

/* ========== SEND BUFFER (AMORTIZATION) ========= */
SensorData arrSendBuffer[Config::iSEND_BUFFER_SAMPLES];
int iSendBufferIndex = 0;
int iSendBufferCount = 0;
unsigned long ulLastSendMillis = 0;

/* =========================
   ==== COLOR MANAGER ======
   ========================= */
class ColorManager {
private:
    const uint16_t BG = Utils::CreateColorBGR(30,22,18);
    const uint16_t CARD = Utils::CreateColorBGR(48,35,28);
    const uint16_t HEADER = Utils::CreateColorBGR(60,45,35);
    const uint16_t TEXT = Utils::CreateColorBGR(250,245,240);
    const uint16_t BORDER = Utils::CreateColorBGR(85,65,50);
    const uint16_t GAUGE_BG = Utils::CreateColorBGR(42,32,25);
    const uint16_t SUCCESS = Utils::CreateColorBGR(130,220,70);
    const uint16_t WARNING = Utils::CreateColorBGR(60,180,255);
    const uint16_t DANGER = Utils::CreateColorBGR(100,75,255);
    const uint16_t ACCENT = Utils::CreateColorBGR(50,200,255);
    const uint16_t SECONDARY = Utils::CreateColorBGR(255,210,100);
    const uint16_t HISTORY = Utils::CreateColorBGR(150,180,200);

public:
    uint16_t GetAQIColor(int iAQI) const {
        switch(iAQI) {
            case 1: return Utils::CreateColorBGR(160,255,100);
            case 2: return Utils::CreateColorBGR(120,230,140);
            case 3: return WARNING;
            case 4: return Utils::CreateColorBGR(80,140,255);
            case 5: return Utils::CreateColorBGR(110,80,255);
            default: return WARNING;
        }
    }
    uint16_t GetCO2Color(int iCO2) const {
        if (iCO2 <= Config::Scales::iCO2_GOOD) return SUCCESS;
        if (iCO2 <= Config::Scales::iCO2_MODERATE) return WARNING;
        if (iCO2 <= Config::Scales::iCO2_POOR) return SECONDARY;
        if (iCO2 <= Config::Scales::iCO2_HAZARDOUS) return DANGER;
        return GetAQIColor(5);
    }
    uint16_t GetTVOCColor(int iTVOC) const {
        if (iTVOC <= Config::Scales::iTVOC_GOOD) return SUCCESS;
        if (iTVOC <= Config::Scales::iTVOC_MODERATE) return WARNING;
        if (iTVOC <= Config::Scales::iTVOC_POOR) return SECONDARY;
        if (iTVOC <= Config::Scales::iTVOC_HAZARDOUS) return DANGER;
        return GetAQIColor(5);
    }
    uint16_t Bg() const { return BG; }
    uint16_t Card() const { return CARD; }
    uint16_t Header() const { return HEADER; }
    uint16_t Text() const { return TEXT; }
    uint16_t Border() const { return BORDER; }
    uint16_t GaugeBg() const { return GAUGE_BG; }
    uint16_t Accent() const { return ACCENT; }
    uint16_t History() const { return HISTORY; }
    uint16_t Warning() const { return WARNING; }
};

ColorManager g_colors;

/* =========================
   ===== SENSOR MANAGER ====
   ========================= */
class SensorManager {
private:
    TFT_eSPI& m_tft;
    SparkFun_ENS160& m_ens;
    AHT20& m_aht;
    bool m_bAHT20Ok = false;
    bool m_bENS160Ok = false;
    unsigned long m_ulLastDebug = 0;
    unsigned long m_ulLastRawDebug = 0;
    unsigned long m_ulLastDataDebug = 0;
    SensorBuffers m_buffers;

    int CalculateAQIFromCO2(int iCO2) {
        if (iCO2 <= 450) return 1;
        if (iCO2 <= 650) return 1;
        if (iCO2 <= 850) return 2;
        if (iCO2 <= 1200) return 3;
        if (iCO2 <= 2000) return 4;
        return 5;
    }
    int CalculateAQIFromTVOC(int iTVOC) {
        if (iTVOC <= 25) return 1;
        if (iTVOC <= 50) return 1;
        if (iTVOC <= 100) return 2;
        if (iTVOC <= 200) return 3;
        if (iTVOC <= 400) return 4;
        return 5;
    }
    int CalculateOverallAQI(int iCO2, int iTVOC) {
        int iAQI_CO2 = CalculateAQIFromCO2(iCO2);
        int iAQI_TVOC = CalculateAQIFromTVOC(iTVOC);
        if (millis() - m_ulLastDebug > 10000) {
            m_ulLastDebug = millis();
            Serial.printf("AQI calc: CO2 %d->%d TVOC %d->%d\n", iCO2, iAQI_CO2, iTVOC, iAQI_TVOC);
        }
        return max(iAQI_CO2, iAQI_TVOC);
    }

    float ExponentialSmoothing(float fCurrent, float fPrev, float fAlpha) const {
        return isnan(fCurrent) ? fPrev : fPrev + fAlpha * (fCurrent - fPrev);
    }
    int ExponentialSmoothing(int iCurrent, int iPrev, float fAlpha) const {
        return iPrev + (int)(fAlpha * (iCurrent - iPrev));
    }

    float AvgFloatBuffer(float arr[], int iSize) const {
        float fSum = 0.0f; int iCount = 0;
        for (int i=0;i<iSize;i++) {
            if (!isnan(arr[i]) && arr[i] != 0.0f) { fSum += arr[i]; iCount++; }
        }
        return iCount>0 ? (fSum / iCount) : NAN;
    }
    int AvgIntBuffer(int arr[], int iSize) const {
        long lSum = 0; int iCount = 0;
        for (int i=0;i<iSize;i++) {
            if (arr[i] != 0) { lSum += arr[i]; iCount++; }
        }
        return iCount>0 ? (int)(lSum / iCount) : 0;
    }

public:
    SensorManager(TFT_eSPI& tft, SparkFun_ENS160& ens, AHT20& aht) : m_tft(tft), m_ens(ens), m_aht(aht) {}

    bool Begin() {
        Serial.println("\nInit sensors...");
        Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
        Wire.setClock(100000);

        m_bAHT20Ok = m_aht.begin();
        Serial.println(m_bAHT20Ok ? "AHT20 OK" : "AHT20 FAIL");

        m_bENS160Ok = m_ens.begin();
        if (m_bENS160Ok) {
            m_ens.setOperatingMode(SFE_ENS160_STANDARD);
            Serial.println("ENS160 OK");
            delay(2000);
        } else {
            Serial.println("ENS160 FAIL");
        }
        return m_bAHT20Ok || m_bENS160Ok;
    }

    void ReadSensors(SensorData& outData) {
        // AHT20
        outData.bTempHumValid = ReadAHT20(outData.fTemperature, outData.fHumidity);
        if (!outData.bTempHumValid) { outData.fTemperature = NAN; outData.fHumidity = NAN; }

        // ENS160
        outData.bENS160Valid = ReadENS160(outData.iAQI, outData.iECO2, outData.iTVOC);

        // COMPUTE AQI IF ENS160 INVALID BUT ECO2/TVOC PRESENT
        if (!outData.bENS160Valid && outData.iECO2 > 0 && outData.iTVOC >= 0) {
            outData.iAQI = CalculateOverallAQI(outData.iECO2, outData.iTVOC);
            outData.bENS160Valid = true;
        }

        // MQ135
        outData.iToxicLevel = ReadMQ135();

        // UPDATE LOCAL SMOOTHING BUFFERS
        UpdateBuffers(outData);
        LogData(outData);
    }

    void ApplySmoothing(SensorData& smoothed, const SensorData& newData) {
        smoothed.fTemperature = ExponentialSmoothing(AvgFloatBuffer(m_buffers.arrfTemperature, Config::iSAMPLE_BUFFER_SIZE), smoothed.fTemperature, Config::fSMOOTHING_ALPHA);
        smoothed.fHumidity = ExponentialSmoothing(AvgFloatBuffer(m_buffers.arrfHumidity, Config::iSAMPLE_BUFFER_SIZE), smoothed.fHumidity, Config::fSMOOTHING_ALPHA);
        smoothed.iAQI = ExponentialSmoothing(AvgIntBuffer(m_buffers.arriAQI, Config::iSAMPLE_BUFFER_SIZE), smoothed.iAQI, Config::fSMOOTHING_ALPHA);
        smoothed.iECO2 = ExponentialSmoothing(AvgIntBuffer(m_buffers.arriECO2, Config::iSAMPLE_BUFFER_SIZE), smoothed.iECO2, Config::fSMOOTHING_ALPHA);
        smoothed.iTVOC = ExponentialSmoothing(AvgIntBuffer(m_buffers.arriTVOC, Config::iSAMPLE_BUFFER_SIZE), smoothed.iTVOC, Config::fSMOOTHING_ALPHA);
        smoothed.iToxicLevel = ExponentialSmoothing(AvgIntBuffer(m_buffers.arriToxicLevel, Config::iSAMPLE_BUFFER_SIZE), smoothed.iToxicLevel, Config::fSMOOTHING_ALPHA);
        smoothed.bTempHumValid = (!isnan(smoothed.fTemperature) && !isnan(smoothed.fHumidity));
        smoothed.bENS160Valid = (smoothed.iECO2 > 0 && smoothed.iTVOC >= 0);
        if (smoothed.bENS160Valid && smoothed.iAQI < 1) smoothed.iAQI = 1;
    }

    bool AHT20Available() const { return m_bAHT20Ok; }
    bool ENS160Available() const { return m_bENS160Ok; }

private:
    bool ReadAHT20(float &fTemp, float &fHum) {
        if (!m_bAHT20Ok) return false;
        fTemp = m_aht.getTemperature();
        fHum = m_aht.getHumidity();
        return (!isnan(fTemp) && !isnan(fHum) && fTemp >= -40.0f && fTemp <= 85.0f && fHum >= 0.0f && fHum <= 100.0f);
    }

    bool ReadENS160(int &iAQI, int &iECO2, int &iTVOC) {
        if (!m_bENS160Ok || !m_ens.checkDataStatus()) return false;
        int iRawAQI = m_ens.getAQI();
        iECO2 = m_ens.getECO2();
        iTVOC = m_ens.getTVOC();
        if (millis() - m_ulLastRawDebug > 8000) {
            m_ulLastRawDebug = millis();
            Serial.printf("ENS160 raw: AQI %d ECO2 %d TVOC %d\n", iRawAQI, iECO2, iTVOC);
        }
        if (iECO2 > 0 && iTVOC >= 0) {
            iAQI = CalculateOverallAQI(iECO2, iTVOC);
            return true;
        }
        return false;
    }

    int ReadMQ135() const {
        return Utils::ConstrainMap(analogRead(MQ135_PIN), 400, 3000, 0, 100);
    }

    void UpdateBuffers(const SensorData& newData) {
        if (!isnan(newData.fTemperature)) m_buffers.arrfTemperature[m_buffers.iIndex] = newData.fTemperature;
        if (!isnan(newData.fHumidity)) m_buffers.arrfHumidity[m_buffers.iIndex] = newData.fHumidity;
        m_buffers.arriAQI[m_buffers.iIndex] = newData.iAQI;
        m_buffers.arriECO2[m_buffers.iIndex] = newData.iECO2;
        m_buffers.arriTVOC[m_buffers.iIndex] = newData.iTVOC;
        m_buffers.arriToxicLevel[m_buffers.iIndex] = newData.iToxicLevel;
        m_buffers.iIndex = (m_buffers.iIndex + 1) % Config::iSAMPLE_BUFFER_SIZE;
    }

    void LogData(const SensorData& data) {
        if (millis() - m_ulLastDataDebug > 5000) {
            m_ulLastDataDebug = millis();
            Serial.printf("Read: AQI %d, CO2 %d, TVOC %d, Temp %.1f\n", data.iAQI, data.iECO2, data.iTVOC, data.fTemperature);
        }
    }
};

/* =========================
   ===== DISPLAY MANAGER ===
   ========================= */
class DisplayManager {
private:
    TFT_eSPI& m_tft;
    const ColorManager& m_colors;
    int m_iCurrentScreen = 0;
    int m_iLastScreen = -1;
    SensorData m_lastDisplayed;
    bool m_bForceRedraw = true;

    struct Layout { 
        static const int HEADER_H = 40; static const int AQI_R = 65; static const int S_R = 42;
        static const int AQI_Y = 110; static const int TH_Y = 220;
        static const int S1X=70,S2X=170,S3X=120; static const int S1Y=110,S2Y=110,S3Y=210; 
    };

    void DrawHeader(const String& sTitle, bool bFresh) {
        m_tft.fillRect(0,0,240,Layout::HEADER_H, m_colors.Header());
        for (int i=0;i<4;i++) m_tft.drawFastHLine(0,36+i,240, Utils::CreateColorBGR(25+i*8,55+i*5,95+i*3));
        SetTextStyle(m_colors.Text(), m_colors.Header(), TC_DATUM);
        m_tft.drawString(sTitle, 120, 14, 2);
        SetTextStyle(Utils::CreateColorBGR(180,200,220), m_colors.Header(), TR_DATUM);
        m_tft.drawString(String(m_iCurrentScreen+1)+"/"+String(Config::iTOTAL_SCREENS), 230, 14, 1);
        m_tft.fillCircle(15,20,5, bFresh ? m_colors.GetAQIColor(1) : m_colors.Warning());
    }
    void SetTextStyle(uint16_t color, uint16_t bg, uint8_t datum) {
        m_tft.setTextColor(color, bg);
        m_tft.setTextDatum(datum);
        m_tft.setTextFont(2);
    }
    void DrawAQIGauge(int x,int y,int r,int iAQI,bool bValid) {
        bool bShow = bValid || iAQI>0;
        uint16_t uColor = bShow ? m_colors.GetAQIColor(iAQI) : m_colors.Warning();
        m_tft.fillSmoothCircle(x,y,r,m_colors.GaugeBg(), m_colors.Bg());
        m_tft.drawSmoothCircle(x,y,r,m_colors.Border(), m_colors.Bg());
        if (bShow && iAQI>0) {
            int sweep = Utils::ConstrainMap(iAQI,1,5,0,300);
            m_tft.drawSmoothArc(x,y,r,r-8,30,30+sweep,uColor,m_colors.Bg(), true);
        }
        m_tft.fillSmoothCircle(x,y,r-20,m_colors.Bg(), m_colors.Bg());
        SetTextStyle(uColor, m_colors.Bg(), MC_DATUM);
        m_tft.setTextSize(2);
        m_tft.drawString(bShow && iAQI>0 ? String(iAQI) : "-", x, y-8, 4);
        m_tft.setTextSize(1);
        SetTextStyle(m_colors.Text(), m_colors.Bg(), MC_DATUM);
        m_tft.drawString("AQI", x, y+12, 2);
        String sStatus = bShow ? GetAQIStatus(iAQI) : "NO DATA";
        SetTextStyle(bShow ? m_colors.Text() : m_colors.Warning(), m_colors.Bg(), MC_DATUM);
        m_tft.drawString(sStatus, x, y+30, 2);
    }
    String GetAQIStatus(int iAQI) const { static const char* arr[] = {"","EXCELLENT","GOOD","MODERATE","POOR","HAZARDOUS"}; return (iAQI>=1 && iAQI<=5) ? arr[iAQI] : "NO DATA"; }

    void DrawTempHum(int x,int y,float fTemp,float fHum,bool bValid) {
        const int iW = 220, iH = 70;
        m_tft.fillRoundRect(x-iW/2, y-iH/2, iW, iH, 12, m_colors.Card());
        m_tft.drawRoundRect(x-iW/2, y-iH/2, iW, iH, 12, m_colors.Border());
        m_tft.drawFastVLine(x, y-iH/2+15, iH-30, m_colors.Border());
        SetTextStyle(m_colors.Text(), m_colors.Card(), TC_DATUM);
        m_tft.drawString("TEMPERATURE", x-55, y-20, 2);
        SetTextStyle(bValid ? m_colors.Accent() : m_colors.Warning(), m_colors.Card(), TC_DATUM);
        m_tft.drawString(bValid && !isnan(fTemp) ? String(fTemp,1)+"°C" : "---.-°C", x-55, y+5, 4);
        SetTextStyle(m_colors.Text(), m_colors.Card(), TC_DATUM);
        m_tft.drawString("HUMIDITY", x+55, y-20, 2);
        SetTextStyle(bValid ? m_colors.Accent() : m_colors.Warning(), m_colors.Card(), TC_DATUM);
        m_tft.drawString(bValid && !isnan(fHum) ? String(fHum,0)+"%" : "---%", x+55, y+5, 4);
    }

    void DrawSensorsScreen(const SensorData& d, bool bFresh, bool bAht, bool bEns) {
        DrawHeader("SENSOR READINGS", bFresh);
        bool bShow = d.bENS160Valid || (d.iECO2>0 && d.iTVOC>=0);
        int iCO2Pct = bShow ? Utils::ConstrainMap(d.iECO2, 400, Config::Scales::iCO2_POOR, 0, 75) : 0;
        int iTVOCPct = bShow ? Utils::ConstrainMap(d.iTVOC, 0, Config::Scales::iTVOC_POOR, 0, 75) : 0;
        DrawGauge(Layout::S1X, Layout::S1Y, Layout::S_R, bShow ? String(d.iECO2) : "---", "ppm", "CO2", m_colors.GetCO2Color(d.iECO2), iCO2Pct, bShow);
        DrawGauge(Layout::S2X, Layout::S2Y, Layout::S_R, bShow ? String(d.iTVOC) : "---", "ppb", "TVOC", m_colors.GetTVOCColor(d.iTVOC), iTVOCPct, bShow);
        DrawGauge(Layout::S3X, Layout::S3Y, Layout::S_R, String(d.iToxicLevel), "level", "TOXIC", m_colors.GetTVOCColor(d.iToxicLevel), d.iToxicLevel, true);
    }

    // small helper for gauge draw (kept concise)
    void DrawGauge(int x,int y,int r,const String& sValue,const String& sUnit,const String& sTitle,uint16_t color,int percent,bool valid) {
        m_tft.fillSmoothCircle(x,y,r, m_colors.GaugeBg(), m_colors.Bg());
        m_tft.drawSmoothCircle(x,y,r, m_colors.Border(), m_colors.Bg());
        if (valid && percent>0) {
            int sweep = Utils::ConstrainMap(percent, 0, 100, 0, 360);
            m_tft.drawSmoothArc(x,y,r,r-8,0,sweep,color,m_colors.Bg(),true);
        }
        m_tft.fillSmoothCircle(x,y,r-18, m_colors.Bg(), m_colors.Bg());
        SetTextStyle(valid ? color : m_colors.Warning(), m_colors.Bg(), MC_DATUM);
        m_tft.drawString(valid ? sValue : "---", x, y - 8, 2);
        SetTextStyle(m_colors.Text(), m_colors.Bg(), MC_DATUM);
        m_tft.drawString(sUnit, x, y+10, 1);
        m_tft.drawString(sTitle, x, y + r + 12, 1);
    }

public:
    DisplayManager(TFT_eSPI& tft, const ColorManager& colors) : m_tft(tft), m_colors(colors) {}
    void Begin() { m_tft.init(); m_tft.setRotation(0); m_tft.setTextFont(2); m_tft.fillScreen(m_colors.Bg()); }
    void DrawScreen(int iScreen, const SensorData& d, bool bFresh, bool bAht, bool bEns) {
        if (!ShouldRedraw(iScreen,d)) return;
        m_tft.fillScreen(m_colors.Bg());
        switch(iScreen) {
            case 0: DrawAQIScreen(d,bFresh); break;
            case 1: DrawSensorsScreen(d,bFresh,bAht,bEns); break;
        }
        m_iLastScreen = iScreen;
        m_lastDisplayed = d;
        m_bForceRedraw = false;
    }
    void SetCurrentScreen(int i) { m_iCurrentScreen = i; }
    void ForceRedrawNext() { m_bForceRedraw = true; }

private:
    void DrawAQIScreen(const SensorData& d, bool bFresh) {
        DrawHeader("AIR QUALITY", bFresh);
        DrawAQIGauge(120, Layout::AQI_Y, Layout::AQI_R, d.iAQI, d.bENS160Valid);
        DrawTempHum(120, Layout::TH_Y, d.fTemperature, d.fHumidity, d.bTempHumValid);
    }
    bool ShouldRedraw(int iScreen, const SensorData& newD) {
        if (m_bForceRedraw || iScreen != m_iLastScreen) return true;
        return (abs(newD.iAQI - m_lastDisplayed.iAQI) >= 1 ||
                abs(newD.iECO2 - m_lastDisplayed.iECO2) >= 10 ||
                abs(newD.iTVOC - m_lastDisplayed.iTVOC) >= 5 ||
                abs(newD.fTemperature - m_lastDisplayed.fTemperature) >= 0.5 ||
                abs(newD.fHumidity - m_lastDisplayed.fHumidity) >= 2);
    }
};

/* =========================
   ======= APPLICATION =====
   ========================= */
SensorManager g_sensors(g_tft, g_ens160, g_aht20);
DisplayManager g_display(g_tft, g_colors);

class AirQualityMonitor {
private:
    TFT_eSPI m_tft;
    SparkFun_ENS160 m_ens;
    AHT20 m_aht;
    ColorManager m_colors;
    SensorManager* m_pSensors;
    DisplayManager* m_pDisplay;

    unsigned long ulLastSensorRead = 0;
    unsigned long ulLastDisplayUpdate = 0;
    unsigned long ulLastScreenChange = 0;
    int iCurrentScreen = 0;
    bool bNeedsRedraw = true;

    SensorData m_currentData;
    SensorData m_smoothedData;

public:
    AirQualityMonitor(SensorManager* pS, DisplayManager* pD)
        : m_pSensors(pS), m_pDisplay(pD)
    {
        // INITIAL SMOOTHED DATA
        m_smoothedData.fTemperature = 20.0f;
        m_smoothedData.fHumidity = 50.0f;
        m_smoothedData.iAQI = 1;
        m_smoothedData.iECO2 = 400;
        m_smoothedData.iTVOC = 0;
        m_smoothedData.iToxicLevel = 0;
        m_smoothedData.bTempHumValid = false;
        m_smoothedData.bENS160Valid = false;
    }

    void Begin() {
        Serial.begin(115200);
        delay(500);
        Serial.println("\nAir Quality Monitor - starting");
        if (!m_pSensors->Begin()) {
            Serial.println("CRITICAL: sensors failed to initialize");
            return;
        }
        m_pDisplay->Begin();
        // INITIAL WARM-UP READS
        m_pSensors->ReadSensors(m_currentData);
        for (int i=0;i<Config::iSAMPLE_BUFFER_SIZE;i++) {
            m_pSensors->ApplySmoothing(m_smoothedData, m_currentData);
            delay(100);
        }
        m_pDisplay->DrawScreen(0, m_smoothedData, true, m_pSensors->AHT20Available(), m_pSensors->ENS160Available());
        Serial.println("System ready");
    }

    void Loop() {
        unsigned long ulNow = millis();
        // SENSOR READ
        if (ulNow - ulLastSensorRead >= Config::ulSAMPLE_INTERVAL_MS) {
            ulLastSensorRead = ulNow;
            m_pSensors->ReadSensors(m_currentData);
            m_pSensors->ApplySmoothing(m_smoothedData, m_currentData);
            bNeedsRedraw = true;
        }
        // DISPLAY UPDATE
        if (ulNow - ulLastDisplayUpdate >= Config::ulDISPLAY_UPDATE_MS) {
            ulLastDisplayUpdate = ulNow;
            if (bNeedsRedraw) {
                bool bFresh = (ulNow - ulLastDisplayUpdate) < Config::ulDATA_FRESH_THRESHOLD_MS;
                m_pDisplay->DrawScreen(iCurrentScreen, m_smoothedData, bFresh, m_pSensors->AHT20Available(), m_pSensors->ENS160Available());
                bNeedsRedraw = false;
                LogCurrentData();
            }
        }
        // ROTATE SCREEN
        if (ulNow - ulLastScreenChange >= Config::ulSCREEN_CHANGE_MS) {
            ulLastScreenChange = ulNow;
            iCurrentScreen = (iCurrentScreen + 1) % Config::iTOTAL_SCREENS;
            m_pDisplay->SetCurrentScreen(iCurrentScreen);
            m_pDisplay->ForceRedrawNext();
            bNeedsRedraw = true;
        }
    }

    // EXPOSE LATEST SMOOTHED 
    SensorData GetSmoothedData() const { return m_smoothedData; }

private:
    void LogCurrentData() {
        static unsigned long ulLastLog = 0;
        if (millis() - ulLastLog > 3000) {
            ulLastLog = millis();
            Serial.printf("LOG: AQI %d CO2 %d TVOC %d\n", m_smoothedData.iAQI, m_smoothedData.iECO2, m_smoothedData.iTVOC);
        }
    }
};

AirQualityMonitor g_monitor(&g_sensors, &g_display);

/* =========================
   ===== NETWORK / SENDER ==
   ========================= */
void SendDataToCloud(const SensorData& sd) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected - skipping send");
        return;
    }
    HTTPClient http;
    http.setTimeout(5000);
    http.begin(pszServerUrl); 
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<256> doc;
    doc["temperature"] = sd.fTemperature;
    doc["humidity"] = sd.fHumidity;
    doc["aqi"] = sd.iAQI;
    doc["co2_ppm"] = sd.iECO2;
    doc["tvoc_ppb"] = sd.iTVOC;
    doc["gases_ppm"] = sd.iToxicLevel;

    String sPayload;
    serializeJson(doc, sPayload);

    int iResp = http.POST(sPayload);
    if (iResp > 0) {
        if (iResp == 200) {
            Serial.println("SENT: ok (200)");
        } else {
            Serial.printf("SENT: http %d\n", iResp);
        }
    } else {
        Serial.printf("SENT: failed (%d)\n", iResp);
    }
    http.end();
}

void PushSampleForSend(const SensorData& sd) {
    arrSendBuffer[iSendBufferIndex] = sd;
    iSendBufferIndex = (iSendBufferIndex + 1) % Config::iSEND_BUFFER_SAMPLES;
    if (iSendBufferCount < Config::iSEND_BUFFER_SAMPLES) iSendBufferCount++;
}

SensorData ComputeAverageSend() {
    SensorData avg;
    // INITIALIZE
    avg.fTemperature = 0.0f; avg.fHumidity = 0.0f; avg.iAQI = 0; avg.iECO2 = 0; avg.iTVOC = 0; avg.iToxicLevel = 0;
    if (iSendBufferCount == 0) return avg;
    for (int i=0;i<iSendBufferCount;i++) {
        avg.fTemperature += arrSendBuffer[i].fTemperature;
        avg.fHumidity += arrSendBuffer[i].fHumidity;
        avg.iAQI += arrSendBuffer[i].iAQI;
        avg.iECO2 += arrSendBuffer[i].iECO2;
        avg.iTVOC += arrSendBuffer[i].iTVOC;
        avg.iToxicLevel += arrSendBuffer[i].iToxicLevel;
    }
    avg.fTemperature /= iSendBufferCount;
    avg.fHumidity /= iSendBufferCount;
    avg.iAQI = (int) (avg.iAQI / iSendBufferCount);
    avg.iECO2 = (int) (avg.iECO2 / iSendBufferCount);
    avg.iTVOC = (int) (avg.iTVOC / iSendBufferCount);
    avg.iToxicLevel = (int) (avg.iToxicLevel / iSendBufferCount);
    return avg;
}

/* ========== SETUP / LOOP ========== */
void setup() {
    // WiFi connect
    WiFi.mode(WIFI_STA);
    WiFi.begin(pszWiFiSSID, pszWiFiPass);
    Serial.print("Connecting WiFi");
    unsigned long ulStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - ulStart < 15000) {
        delay(500);
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi not connected (proceeding - will retry later)");
    }

    g_monitor.Begin();
    ulLastSendMillis = millis();
}

void loop() {
    g_monitor.Loop();

    SensorData sd = g_monitor.GetSmoothedData();
    PushSampleForSend(sd);

    unsigned long ulNow = millis();
    if (ulNow - ulLastSendMillis >= Config::ulSEND_INTERVAL_MS) {
        ulLastSendMillis = ulNow;
        SensorData avg = ComputeAverageSend();
        SendDataToCloud(avg);
        iSendBufferCount = 0;
        iSendBufferIndex = 0;
    }

    delay(50);
}
