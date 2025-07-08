// Bot de Trading para XAU/USD com CCI, ATR e OBV via Twelve Data
require("dotenv").config();
const axios = require("axios");
const { Telegraf } = require("telegraf");
const { EMA } = require("technicalindicators");
const { Decimal } = require("decimal.js");
const fs = require("fs").promises;

// ================= CONFIGURAÇÕES ================= //
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GOLD_API_BASE_URL = "https://api.gold-api.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOL_TD = "XAU/USD";
const SYMBOL_GOLD_API = "XAU";
const INTERVAL_15M = "5min";
const INTERVAL_1H = "1h";
const EMA_FAST = 13;
const EMA_SLOW = 21;
const EMA_TREND = 50;
const CCI_THRESHOLD_LONG = new Decimal("-100");
const CCI_THRESHOLD_SHORT = new Decimal("100");
const LEVERAGE = 10;
const RISK_REWARD_RATIO = new Decimal("2.0");
const INTERVALO_VERIFICACAO_MS = 15 * 60 * 1000;
const INTERVALO_ENTRE_SINAIS_MS = 30 * 60 * 1000;
let ultimoSinalEnviadoTimestamp = 0;
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ================= FUNÇÕES AUXILIARES ================= //
async function fetchIndicator(indicator, symbol, interval, params = {}) {
  try {
    const query = new URLSearchParams({
      symbol,
      interval,
      apikey: TWELVE_DATA_API_KEY,
      ...params
    });
    const url = `https://api.twelvedata.com/${indicator}?${query.toString()}`;
    const response = await axios.get(url);
    return response.data.values ? response.data.values.reverse() : null;
  } catch (err) {
    console.error(`Erro ao buscar indicador ${indicator}:`, err.message);
    return null;
  }
}

async function fetchCurrentPrice(symbol) {
  try {
    const url = `${GOLD_API_BASE_URL}/price/${symbol}`;
    const response = await axios.get(url);
    return response.data && response.data.price ? parseFloat(response.data.price) : null;
  } catch (error) {
    console.error("Erro ao buscar preço atual:", error.message);
    return null;
  }
}

async function fetchPriceSeries(symbol, interval) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=60&apikey=${TWELVE_DATA_API_KEY}`;
    const response = await axios.get(url);
    if (response.data && response.data.values) {
      const data = response.data.values.reverse();
      return {
        close: data.map(d => parseFloat(d.close)),
        high: data.map(d => parseFloat(d.high)),
        low: data.map(d => parseFloat(d.low))
      };
    }
    return null;
  } catch (err) {
    console.error("Erro ao buscar candles:", err.message);
    return null;
  }
}

function isOBVRising(obvData) {
  const last = parseFloat(obvData[obvData.length - 1]?.obv);
  const prev = parseFloat(obvData[obvData.length - 2]?.obv);
  return last > prev;
}

// ================= LÓGICA DE SINAL ================= //
async function checkSignals() {
  try {
    console.log("\nVerificando sinais...");
    const data15m = await fetchPriceSeries(SYMBOL_TD, INTERVAL_15M);
    const data1h = await fetchPriceSeries(SYMBOL_TD, INTERVAL_1H);
    const currentPrice = await fetchCurrentPrice(SYMBOL_GOLD_API);

    const cciData = await fetchIndicator("cci", SYMBOL_TD, INTERVAL_15M, { time_period: 20 });
    const atrData = await fetchIndicator("atr", SYMBOL_TD, INTERVAL_15M, { time_period: 14 });
    const obvData = await fetchIndicator("obv", SYMBOL_TD, INTERVAL_15M);

    if (!data15m || !data1h || !currentPrice || !cciData || !atrData || !obvData) {
      console.error("Erro: Dados incompletos.");
      await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "❌ Erro ao buscar dados para análise.");
      return;
    }

    const close15m = [...data15m.close];
    close15m[close15m.length - 1] = currentPrice;
    const ema13 = EMA.calculate({ period: EMA_FAST, values: close15m });
    const ema21 = EMA.calculate({ period: EMA_SLOW, values: close15m });
    const ema50 = EMA.calculate({ period: EMA_TREND, values: close15m });
    const trendH1 = data1h.close[data1h.close.length - 1] > EMA.calculate({ period: EMA_TREND, values: data1h.close }).slice(-1)[0];

    const lastCCI = parseFloat(cciData.at(-1)?.cci);
    const lastATR = new Decimal(parseFloat(atrData.at(-1)?.atr || 0));
    const obvRising = isOBVRising(obvData);

    //const signalLong = trendH1 && (ema13.at(-1) > ema21.at(-1)) && (close15m.at(-1) > ema50.at(-1)) && lastCCI > 0 && obvRising;
    const signalLong = (ema13.at(-1) > ema21.at(-1)) && (close15m.at(-1) > ema50.at(-1)) && lastCCI > -100 && obvRising;
    const signalShort = !trendH1 && (ema13.at(-1) < ema21.at(-1)) && (close15m.at(-1) < ema50.at(-1)) && lastCCI < 100 && !obvRising;

    const direction = signalLong ? 1 : signalShort ? -1 : 0;

    console.log("==================== DEBUG ====================");
    console.log(`CCI: ${lastCCI}, ATR: ${lastATR.toFixed(2)}, OBV subindo: ${obvRising}`);
    console.log(`EMA13: ${ema13.at(-1)}, EMA21: ${ema21.at(-1)}, EMA50: ${ema50.at(-1)}`);
    console.log(`Sinal: ${direction === 1 ? "LONG" : direction === -1 ? "SHORT" : "NEUTRO"}`);

    if (direction === 0) return;

    const entry = new Decimal(currentPrice);
    const stop = direction === 1 ? entry.minus(lastATR) : entry.plus(lastATR);
    const tp = direction === 1 ? entry.plus(lastATR.times(RISK_REWARD_RATIO)) : entry.minus(lastATR.times(RISK_REWARD_RATIO));

    const msg = `${direction === 1 ? "🟢 LONG" : "🔴 SHORT"} XAU/USD\nEntrada: ${entry.toFixed(2)}\nTP: ${tp.toFixed(2)}\nSL: ${stop.toFixed(2)}\nCCI: ${lastCCI}\nOBV subindo: ${obvRising}`;
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg);

    await fs.appendFile("signal_report.csv", `${new Date().toISOString()},XAU/USD,${direction === 1 ? "LONG" : "SHORT"},${entry.toFixed(2)},${tp.toFixed(2)},${stop.toFixed(2)},PENDING\n`);
    ultimoSinalEnviadoTimestamp = Date.now();
  } catch (err) {
    console.error("Erro ao verificar sinais:", err.message);
  }
}

// ================= INICIALIZAÇÃO ================= //
(async () => {
  console.log("Bot iniciado!");
  await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "✅ Bot de XAU/USD iniciado via API!");
  await checkSignals();
  setInterval(checkSignals, INTERVALO_VERIFICACAO_MS);
})();
