import dotenv from 'dotenv';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { EMA } from 'technicalindicators';
import { Decimal } from 'decimal.js';
import { promises as fs } from 'fs';

dotenv.config();

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
const LEVERAGE = 10;
const RISK_REWARD_RATIO = new Decimal("2.0");
const INTERVALO_VERIFICACAO_MS = 15 * 60 * 1000;
const COOLDOWN_SINAL_MS = 30 * 60 * 1000; // 30 minutos de cooldown para sinais
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos para heartbeat
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
let ultimoSinalEnviadoTimestamp = 0;
const sinaisAtivos = []; // Armazena sinais ativos pra rastrear TP/SL

// ================= FUNÇÕES AUXILIARES ================= //
async function fetchIndicator(indicator, symbol, interval, params = {}) {
  try {
    const query = new URLSearchParams({ symbol, interval, apikey: TWELVE_DATA_API_KEY, ...params });
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

// ================= RASTREAMENTO DE ALVOS ================= //
async function checkTargets() {
  try {
    const currentPrice = await fetchCurrentPrice(SYMBOL_GOLD_API);
    if (!currentPrice) {
      console.error("Erro ao buscar preço para rastrear alvos.");
      return;
    }

    for (let i = sinaisAtivos.length - 1; i >= 0; i--) {
      const sinal = sinaisAtivos[i];
      const { entry, tp, stop, direction, timestamp } = sinal;
      let atingido = false;
      let resultado = '';

      if (direction === 1) { // LONG
        if (currentPrice >= tp) {
          atingido = true;
          resultado = `✅ TP atingido (LONG) para XAU/USD!\nEntrada: ${entry.toFixed(2)}\nTP: ${tp.toFixed(2)}\nPreço Atual: ${currentPrice.toFixed(2)}`;
        } else if (currentPrice <= stop) {
          atingido = true;
          resultado = `❌ SL atingido (LONG) para XAU/USD!\nEntrada: ${entry.toFixed(2)}\nSL: ${stop.toFixed(2)}\nPreço Atual: ${currentPrice.toFixed(2)}`;
        }
      } else if (direction === -1) { // SHORT
        if (currentPrice <= tp) {
          atingido = true;
          resultado = `✅ TP atingido (SHORT) para XAU/USD!\nEntrada: ${entry.toFixed(2)}\nTP: ${tp.toFixed(2)}\nPreço Atual: ${currentPrice.toFixed(2)}`;
        } else if (currentPrice >= stop) {
          atingido = true;
          resultado = `❌ SL atingido (SHORT) para XAU/USD!\nEntrada: ${entry.toFixed(2)}\nSL: ${stop.toFixed(2)}\nPreço Atual: ${currentPrice.toFixed(2)}`;
        }
      }

      if (atingido) {
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, resultado);
        await fs.appendFile("signal_report.csv", `${new Date(timestamp).toISOString()},XAU/USD,${direction === 1 ? "LONG" : "SHORT"},${entry.toFixed(2)},${tp.toFixed(2)},${stop.toFixed(2)},${resultado.includes("TP") ? "TP" : "SL"}\n`);
        sinaisAtivos.splice(i, 1);
      }
    }
  } catch (err) {
    console.error("Erro ao verificar alvos:", err.message);
  }
}

// ================= HEARTBEAT ================= //
async function sendHeartbeat() {
  try {
    const data1h = await fetchPriceSeries(SYMBOL_TD, INTERVAL_1H);
    if (!data1h) {
      await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "🤖 Bot ativo, mas não foi possível verificar a tendência no momento.");
      return;
    }
    const trendH1 = data1h.close.at(-1) > EMA.calculate({ period: EMA_TREND, values: data1h.close }).at(-1);
    const adxData = await fetchIndicator("adx", SYMBOL_TD, INTERVAL_15M, { time_period: 14 });
    const adxValue = adxData && adxData.at(-1)?.adx ? parseFloat(adxData.at(-1).adx) : 0;
    const trendStatus = trendH1 ? "Tendência de alta (1h)" : "Tendência de baixa ou neutra (1h)";
    const signalStatus = Date.now() - ultimoSinalEnviadoTimestamp > COOLDOWN_SINAL_MS ? "Nenhum sinal recente." : "Aguardando cooldown para novo sinal.";
    const activeSignals = sinaisAtivos.length ? `Sinais ativos: ${sinaisAtivos.length}` : "Nenhum sinal ativo.";
    const message = `🤖 Bot ativo!\n${trendStatus}\nADX (15m): ${adxValue.toFixed(2)}\n${signalStatus}\n${activeSignals}`;
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message);
  } catch (err) {
    console.error("Erro no heartbeat:", err.message);
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "🤖 Bot ativo, mas ocorreu um erro ao verificar a tendência.");
  }
}

// ================= LÓGICA DE SINAL ================= //
async function checkSignals() {
  try {
    // Verificar cooldown
    if (Date.now() - ultimoSinalEnviadoTimestamp < COOLDOWN_SINAL_MS) {
      await checkTargets();
      return;
    }

    const data15m = await fetchPriceSeries(SYMBOL_TD, INTERVAL_15M);
    const data1h = await fetchPriceSeries(SYMBOL_TD, INTERVAL_1H);
    const currentPrice = await fetchCurrentPrice(SYMBOL_GOLD_API);

    const cciData = await fetchIndicator("cci", SYMBOL_TD, INTERVAL_15M, { time_period: 20 });
    const atrData = await fetchIndicator("atr", SYMBOL_TD, INTERVAL_1H, { time_period: 14 });
    const adxData = await fetchIndicator("adx", SYMBOL_TD, INTERVAL_15M, { time_period: 14 });
    const plusDI = await fetchIndicator("plus_di", SYMBOL_TD, INTERVAL_15M, { time_period: 14 });
    const minusDI = await fetchIndicator("minus_di", SYMBOL_TD, INTERVAL_15M, { time_period: 14 });

    if (!data15m || !data1h || !currentPrice || !cciData || !atrData || !adxData || !plusDI || !minusDI) {
      console.error("Erro: Dados incompletos.");
      await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "❌ Erro ao buscar dados para análise.");
      await checkTargets();
      return;
    }

    const close15m = [...data15m.close];
    close15m[close15m.length - 1] = currentPrice;
    const ema13 = EMA.calculate({ period: EMA_FAST, values: close15m });
    const ema21 = EMA.calculate({ period: EMA_SLOW, values: close15m });
    const ema50 = EMA.calculate({ period: EMA_TREND, values: close15m });
    const trendH1 = data1h.close.at(-1) > EMA.calculate({ period: EMA_TREND, values: data1h.close }).at(-1);

    const lastCCI = parseFloat(cciData.at(-1)?.cci);
    const lastATR = new Decimal(parseFloat(atrData.at(-1)?.atr || 0));
    const adxValue = parseFloat(adxData.at(-1)?.adx || 0);
    const plusDIValue = parseFloat(plusDI.at(-1)?.plus_di || 0);
    const minusDIValue = parseFloat(minusDI.at(-1)?.minus_di || 0);
    const tendenciaForte = adxValue > 20;

    const signalLong = trendH1 && tendenciaForte &&
                       plusDIValue > minusDIValue &&
                       ema13.at(-1) > ema21.at(-1) &&
                       close15m.at(-1) > ema50.at(-1) &&
                       lastCCI > -100;

    const signalShort = !trendH1 && tendenciaForte &&
                        minusDIValue > plusDIValue &&
                        ema13.at(-1) < ema21.at(-1) &&
                        close15m.at(-1) < ema50.at(-1) &&
                        lastCCI < 100;

    const direction = signalLong ? 1 : signalShort ? -1 : 0;

    if (direction === 0) {
      await checkTargets();
      return;
    }

    const entry = new Decimal(currentPrice);
    const stop = direction === 1 ? entry.minus(lastATR) : entry.plus(lastATR);
    const tp = direction === 1 ? entry.plus(lastATR.times(RISK_REWARD_RATIO)) : entry.minus(lastATR.times(RISK_REWARD_RATIO));

    const msg = `${direction === 1 ? "🟢 LONG" : "🔴 SHORT"} XAU/USD\nEntrada: ${entry.toFixed(2)}\nTP: ${tp.toFixed(2)}\nSL: ${stop.toFixed(2)}\nCCI: ${lastCCI}\nADX: ${adxValue}\nDI+: ${plusDIValue}, DI-: ${minusDIValue}`;
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg);

    // Registrar sinal no CSV e em sinaisAtivos
    const signalData = { entry, tp, stop, direction, timestamp: Date.now() };
    sinaisAtivos.push(signalData);
    await fs.appendFile("signal_report.csv", `${new Date().toISOString()},XAU/USD,${direction === 1 ? "LONG" : "SHORT"},${entry.toFixed(2)},${tp.toFixed(2)},${stop.toFixed(2)},PENDING\n`);
    ultimoSinalEnviadoTimestamp = Date.now();
    await checkTargets();
  } catch (err) {
    console.error("Erro ao verificar sinais:", err.message);
    await checkTargets();
  }
}

// ================= INICIALIZAÇÃO ================= //
(async () => {
  console.error("Bot iniciado!");
  await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "✅ Bot de XAU/USD com ADX/DI iniciado!");
  await checkSignals();
  setInterval(checkSignals, INTERVALO_VERIFICACAO_MS);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
})();
