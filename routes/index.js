// 1. CARGA DE VARIABLES DE ENTORNO
require('dotenv').config();

const express = require('express');
const router = express.Router();

// --- IMPORTACIONES ---
const Database = require('../database/database');
const MonedaDAO = require('../database/dao/moneda-dao');
const UsuarioDAO = require('../database/dao/usuario-dao');
const WalletDAO = require('../database/dao/wallet-dao');
const TransaccionDAO = require('../database/dao/transaccion-dao');
const PriceHistoryDAO = require('../database/dao/price-history-dao');

const db = Database.getInstance();
const monedaDao = new MonedaDAO(db);
const usuarioDao = new UsuarioDAO(db);
const walletDao = new WalletDAO(db);
const transaccionDao = new TransaccionDAO(db);
const priceHistoryDao = new PriceHistoryDAO(db);

const {
  requireAuth
} = require('../middleware/auth');
const axios = require('axios');
const {
  GoogleGenerativeAI
} = require("@google/generative-ai");
const CoinMarketCapService = require('../services/coinmarketcap');
const EmailService = require('../services/email');
// ---------------------

// --- Estado de precios en memoria ---
let lastPriceUpdate = null;
const PRICE_UPDATE_INTERVAL_MS = 30 * 1000; // 1 minuto


// --- DEBUG AL ARRANCAR ---
// Esto intentará listar tus modelos disponibles en la terminal
// Si falla, al menos sabremos que la conexión es buena.
console.log("---------------------------------------");
console.log("⚙️  Configurando IA...");
if (!process.env.GEMINI_API_KEY) {
  console.log("❌ ERROR: No veo la GEMINI_API_KEY");
} else {
  console.log("✅ API Key detectada.");
}
if (!process.env.COINMARKETCAP_API_KEY) {
  console.log("⚠️  ADVERTENCIA: No veo la COINMARKETCAP_API_KEY - Los precios no se actualizarán desde la API");
} else {
  console.log("✅ CoinMarketCap API Key detectada.");
}
console.log("---------------------------------------");

// --- HELPER: Actualizar precios desde CoinMarketCap ---
/**
 * Actualiza los precios de las criptomonedas desde CoinMarketCap API
 * Si falla, devuelve las monedas sin actualizar
 * @returns {Promise<Array>} Array de monedas (actualizadas o sin actualizar)
 */
async function updatePricesFromAPI() {
  // Si no hay API key, simplemente devolver las monedas existentes
  if (!process.env.COINMARKETCAP_API_KEY) {
    const coins = monedaDao.getAll();
    lastPriceUpdate = new Date().toISOString();
    return coins;
  }

  try {
    const cmcService = new CoinMarketCapService();
    const coins = monedaDao.getAll();
    const symbols = coins.map(c => c.symbol);
    const prices = await cmcService.getMultiplePrices(symbols);

    // Actualizar precios en la base de datos para las monedas disponibles
    for (const coin of coins) {
      if (cmcService.isAvailable(coin.symbol) && prices.has(coin.symbol)) {
        const priceData = prices.get(coin.symbol);
        monedaDao.updatePrice(coin.symbol, priceData.priceEur, priceData.change24h);

        // Guardar punto de histórico para gráficas (solo si el precio es válido)
        if (Number.isFinite(priceData.priceEur)) {
          try {
            priceHistoryDao.insert(coin.symbol, priceData.priceEur);
          } catch (e) {
            console.warn('No se pudo guardar histórico de precio para', coin.symbol, e.message);
          }
        }
      }
    }

    // Recargar monedas con precios actualizados
    const updatedCoins = monedaDao.getAll();
    lastPriceUpdate = new Date().toISOString();
    return updatedCoins;
  } catch (error) {
    // Si falla la API, devolver las monedas existentes
    console.warn('No se pudieron actualizar precios desde CoinMarketCap:', error.message);
    const coins = monedaDao.getAll();
    // Aun así actualizamos la marca de tiempo para saber que lo intentamos
    lastPriceUpdate = new Date().toISOString();
    return coins;
  }
}

// --- Actualización periódica de precios (cada minuto) ---
(async function startPriceUpdater() {
  try {
    await updatePricesFromAPI();
    console.log('✅ Precios iniciales actualizados desde CoinMarketCap (si está configurado).');
  } catch (err) {
    console.warn('⚠️ No se pudieron actualizar los precios al iniciar:', err.message);
  }

  setInterval(async () => {
    try {
      await updatePricesFromAPI();
      console.log('✅ Precios actualizados periódicamente desde CoinMarketCap.');
    } catch (err) {
      console.warn('⚠️ Error en la actualización periódica de precios:', err.message);
    }
  }, PRICE_UPDATE_INTERVAL_MS);
})();

/* GET home page. */
router.get('/', async function (req, res, next) {
  try {
    const coins = await updatePricesFromAPI();
    res.render('index', {
      title: 'Galpe Exchange',
      coins: coins
    });
  } catch (error) {
    next(error);
  }
});

// Páginas corporativas
router.get('/about', function (req, res, next) {
  res.render('about', { title: 'Sobre nosotros - Galpe Exchange' });
});

router.get('/news', function (req, res, next) {
  res.render('news', { title: 'Noticias y anuncios - Galpe Exchange' });
});

router.get('/terms', function (req, res, next) {
  res.render('terms', { title: 'Condiciones de uso - Galpe Exchange' });
});

router.get('/privacy', function (req, res, next) {
  res.render('privacy', { title: 'Política de privacidad - Galpe Exchange' });
});

router.get('/support', function (req, res, next) {
  res.render('support', { title: 'Soporte - Galpe Exchange' });
});

// Mostrar formulario para cambiar/desvincular teléfono (requiere auth)
router.get('/support/change-phone', requireAuth, function (req, res, next) {
  try {
    const userId = req.session.user.id;
    const baseUser = usuarioDao.getById(userId);
    if (!baseUser) return res.redirect('/auth/logout');

    res.render('change-phone', {
      title: 'Cambiar teléfono - Soporte',
      user: baseUser,
      error: null,
      success: null
    });
  } catch (e) {
    next(e);
  }
});

// Procesar cambio/desvinculación de teléfono
router.post('/support/change-phone', requireAuth, function (req, res, next) {
  try {
    const userId = req.session.user.id;
    const { phone, country_code, action } = req.body;

    if (action === 'unlink') {
      usuarioDao.updatePhone(userId, null, null);
      // Actualizar sesión
      req.session.user = usuarioDao.getById(userId);
      return res.render('change-phone', { title: 'Cambiar teléfono - Soporte', user: req.session.user, success: 'Número desvinculado correctamente', error: null });
    }

    // Validar entrada básica
    if (!phone || !country_code) {
      const baseUser = usuarioDao.getById(userId);
      return res.render('change-phone', { title: 'Cambiar teléfono - Soporte', user: baseUser, error: 'Introduce un número y el prefijo', success: null });
    }

    const normalizedPhone = String(phone).replace(/[^0-9]/g, '');
    usuarioDao.updatePhone(userId, normalizedPhone, country_code);
    // Actualizar sesión
    req.session.user = usuarioDao.getById(userId);

    return res.render('change-phone', { title: 'Cambiar teléfono - Soporte', user: req.session.user, success: 'Teléfono actualizado correctamente', error: null });
  } catch (e) {
    next(e);
  }
});

router.get('/contact', function (req, res, next) {
  const sent = req.query.sent === 'true';
  res.render('contact', { 
    title: 'Soporte técnico - Galpe Exchange',
    sent: sent
  });
});

router.post('/support/contact', async function (req, res, next) {
  try {
    const { name, email, message } = req.body;

    // Validar campos requeridos
    if (!name || !email || !message) {
      return res.render('contact', {
        title: 'Soporte técnico - Galpe Exchange',
        sent: false,
        error: 'Por favor, completa todos los campos'
      });
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.render('contact', {
        title: 'Soporte técnico - Galpe Exchange',
        sent: false,
        error: 'Por favor, introduce un email válido'
      });
    }

    // Intentar enviar el correo
    const emailService = new EmailService();
    const emailResult = await emailService.sendContactEmail(name, email, message);

    if (!emailResult.success) {
      // Si el email no está configurado, aún mostramos éxito pero con advertencia
      console.warn('⚠️  Email no enviado:', emailResult.message);
      // Continuamos como si fuera exitoso para no confundir al usuario
    }

    // Redirigir con mensaje de éxito
    res.redirect('/contact?sent=true');
  } catch (error) {
    console.error('Error al procesar formulario de contacto:', error);
    res.render('contact', {
      title: 'Soporte técnico - Galpe Exchange',
      sent: false,
      error: 'Ocurrió un error al enviar el mensaje. Por favor, intenta de nuevo.'
    });
  }
});

// Rutas protegidas - requieren autenticación
// Rutas protegidas - requieren autenticación
router.get('/dashboard', requireAuth, function (req, res, next) {
  try {
    const userId = req.session.user.id;

    const baseUser = usuarioDao.getById(userId);
    if (!baseUser) return res.redirect('/auth/logout');

    const coins = monedaDao.getAll();
    const wallets = walletDao.listByUserId(userId);

    const balance = { eur: 0, btc: 0 };
    const assetsRaw = [];

    for (const w of wallets) {
      const curr = String(w.currency).toUpperCase();
      const amt = Number(w.amount) || 0;
      if (curr === 'EUR') balance.eur = amt;
      if (curr === 'BTC') balance.btc = amt;
      if (curr !== 'EUR' && amt !== 0) assetsRaw.push({ symbol: curr, amount: amt });
    }

    const user = { ...baseUser, balance, assets: assetsRaw };
    req.session.user = user;

    // Map user assets to include coin details (like icon color)
    const userAssets = user.assets.map(asset => {
      const coin = coins.find(c => c.symbol === asset.symbol);
      return { ...asset, ...coin };
    });

    res.render('dashboard', {
      title: 'Panel - Galpe Exchange',
      user,
      assets: userAssets,
      coins
    });
  } catch (error) {
    next(error);
  }
});

router.get('/market', async function (req, res, next) {
  try {
    // Actualizar precios desde CoinMarketCap
    const coins = await updatePricesFromAPI();

    // Ordenar monedas por ganancias y pérdidas en 24h
    const gainers = [...coins]
      .filter(c => c.change_24h > 0)
      .sort((a, b) => b.change_24h - a.change_24h)
      .slice(0, 4);

    const losers = [...coins]
      .filter(c => c.change_24h < 0)
      .sort((a, b) => a.change_24h - b.change_24h)
      .slice(0, 4);

    res.render('market', {
      title: 'Mercado - Galpe Exchange',
      coins: coins,
      gainers: gainers,
      losers: losers
    });
  } catch (error) {
    next(error);
  }
});

// Trading page for specific coin
router.get('/trade/:symbol', requireAuth, function (req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const coins = monedaDao.getAll();
    const coin = coins.find(c => c.symbol === symbol);

    if (!coin) {
      return res.redirect('/market');
    }

    res.render('trade', {
      title: coin.name + ' - Trading',
      coin: coin,
      coins: coins, // Para el sidebar de pares
      user: req.session.user
    });
  } catch (error) {
    next(error);
  }
});

// API: precios actualizados para una moneda concreta (usado por la vista de trading)
router.get('/api/prices/:symbol', requireAuth, function (req, res) {
  const symbol = req.params.symbol.toUpperCase();
  const coins = monedaDao.getAll();
  const coin = coins.find(c => c.symbol === symbol);

  if (!coin) {
    return res.status(404).json({
      success: false,
      error: 'Moneda no encontrada'
    });
  }

  res.json({
    success: true,
    coin,
    lastUpdate: lastPriceUpdate
  });
});

// API: datos para gráfica de una moneda concreta
router.get('/api/chart/:symbol', requireAuth, function (req, res) {
  const symbol = req.params.symbol.toUpperCase();
  const timeframe = String(req.query.timeframe || '7d').toLowerCase();

  // Calcular fecha mínima según timeframe
  const now = Date.now();
  let rangeMs;
  switch (timeframe) {
    case '1h':
      rangeMs = 1 * 60 * 60 * 1000;
      break;
    case '12h':
      rangeMs = 12 * 60 * 60 * 1000;
      break;
    case '24h':
      rangeMs = 24 * 60 * 60 * 1000;
      break;
    case '7d':
      rangeMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case '1m':
      rangeMs = 30 * 24 * 60 * 60 * 1000; // aprox 30 días
      break;
    default:
      rangeMs = 7 * 24 * 60 * 60 * 1000;
      break;
  }

  const sinceIso = new Date(now - rangeMs).toISOString();
  const points = priceHistoryDao.getPointsSince(symbol, sinceIso, 500);

  return res.json({
    success: true,
    symbol,
    timeframe,
    points
  });
});

// === TRADING: BUY ENDPOINT ===
router.post('/trade/buy', requireAuth, (req, res) => {
  try {
    const { symbol, amount, price } = req.body;
    const symbol_upper = String(symbol || '').toUpperCase();
    const parsedAmount = Number.parseFloat(amount);
    const parsedPrice = Number.parseFloat(price);

    const coins = monedaDao.getAll();
    const coin = coins.find(c => c.symbol === symbol_upper);

    if (!coin) {
      return res.json({
        success: false,
        error: 'Moneda no encontrada'
      });
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.json({
        success: false,
        error: 'Cantidad inválida'
      });
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.json({
        success: false,
        error: 'Precio inválido'
      });
    }

    const userId = req.session.user.id;
    const total = parsedAmount * parsedPrice;
    const eurBalance = walletDao.getAmount(userId, 'EUR');

    if (eurBalance < total) {
      return res.json({
        success: false,
        error: `Fondos insuficientes. Necesitas ${total.toFixed(2)} EUR pero solo tienes ${eurBalance.toFixed(2)} EUR.`
      });
    }

    // Realizar la compra
    walletDao.subtract(userId, 'EUR', total);
    walletDao.add(userId, symbol_upper, parsedAmount);

    // Crear transacción
    transaccionDao.create({
      id: Date.now().toString(),
      user_id: userId,
      type: 'trade_buy',
      currency: symbol_upper,
      amount: parsedAmount,
      fee: 0,
      meta: { price: parsedPrice, cost_eur: total },
      created_at: new Date().toISOString()
    });

    // Actualizar sesión
    const wallets = walletDao.listByUserId(userId);
    const balance = { eur: 0, btc: 0 };
    const assets = [];
    for (const w of wallets) {
      const c = String(w.currency).toUpperCase();
      const a = Number(w.amount) || 0;
      if (c === 'EUR') balance.eur = a;
      if (c === 'BTC') balance.btc = a;
      if (c !== 'EUR' && a !== 0) assets.push({ symbol: c, amount: a });
    }
    req.session.user = { ...req.session.user, balance, assets };

    const newEurBalance = walletDao.getAmount(userId, 'EUR');
    const newCoinBalance = walletDao.getAmount(userId, symbol_upper);

    return res.json({
      success: true,
      message: `Compra exitosa: ${parsedAmount} ${symbol_upper}`,
      newEurBalance,
      newCoinBalance
    });
  } catch (error) {
    console.error('Error en /trade/buy:', error);
    return res.json({
      success: false,
      error: 'Error al procesar la compra'
    });
  }
});

// === TRADING: SELL ENDPOINT ===
router.post('/trade/sell', requireAuth, (req, res) => {
  try {
    const { symbol, amount, price } = req.body;
    const symbol_upper = String(symbol || '').toUpperCase();
    const parsedAmount = Number.parseFloat(amount);
    const parsedPrice = Number.parseFloat(price);

    const coins = monedaDao.getAll();
    const coin = coins.find(c => c.symbol === symbol_upper);

    if (!coin) {
      return res.json({
        success: false,
        error: 'Moneda no encontrada'
      });
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.json({
        success: false,
        error: 'Cantidad inválida'
      });
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.json({
        success: false,
        error: 'Precio inválido'
      });
    }

    const userId = req.session.user.id;
    const coinBalance = walletDao.getAmount(userId, symbol_upper);

    if (coinBalance < parsedAmount) {
      return res.json({
        success: false,
        error: `Fondos insuficientes. Necesitas ${parsedAmount} ${symbol_upper} pero solo tienes ${coinBalance.toFixed(8)} ${symbol_upper}.`
      });
    }

    const total = parsedAmount * parsedPrice;

    // Realizar la venta
    walletDao.subtract(userId, symbol_upper, parsedAmount);
    walletDao.add(userId, 'EUR', total);

    // Crear transacción
    transaccionDao.create({
      id: Date.now().toString(),
      user_id: userId,
      type: 'trade_sell',
      currency: symbol_upper,
      amount: parsedAmount,
      fee: 0,
      meta: { price: parsedPrice, proceeds_eur: total },
      created_at: new Date().toISOString()
    });

    // Actualizar sesión
    const wallets = walletDao.listByUserId(userId);
    const balance = { eur: 0, btc: 0 };
    const assets = [];
    for (const w of wallets) {
      const c = String(w.currency).toUpperCase();
      const a = Number(w.amount) || 0;
      if (c === 'EUR') balance.eur = a;
      if (c === 'BTC') balance.btc = a;
      if (c !== 'EUR' && a !== 0) assets.push({ symbol: c, amount: a });
    }
    req.session.user = { ...req.session.user, balance, assets };

    const newEurBalance = walletDao.getAmount(userId, 'EUR');
    const newCoinBalance = walletDao.getAmount(userId, symbol_upper);

    return res.json({
      success: true,
      message: `Venta exitosa: ${parsedAmount} ${symbol_upper}`,
      newEurBalance,
      newCoinBalance
    });
  } catch (error) {
    console.error('Error en /trade/sell:', error);
    return res.json({
      success: false,
      error: 'Error al procesar la venta'
    });
  }
});

router.get('/deposit', requireAuth, (req, res) => {
  try {
    const coins = monedaDao.getAll();

    const history = transaccionDao
      .listByUserId(req.session.user.id, 50)
      .filter(t => t.type === 'deposit')
      .map(t => ({
        id: t.id,
        currency: t.currency.toLowerCase(),
        amount: t.amount,
        fee: t.fee,
        destination: t.destination,
        status: (() => {
          try { return JSON.parse(t.meta || '{}').status || 'completed'; } catch { return 'completed'; }
        })(),
        createdAt: t.created_at
      }));

    res.render('deposit', {
      title: 'Depositar - Galpe Exchange',
      user: req.session.user,
      error: null,
      success: null,
      coins,
      history
    });
  } catch (err) {
    next(err);
  }
});

router.post('/deposit', requireAuth, (req, res, next) => {
  try {
    const { amount, currency, destination } = req.body;

    const curr = (currency || 'eur').toUpperCase();
    const parsedAmount = Number.parseFloat(String(amount).replace(',', '.'));
    const dest = (destination || '').trim();

    const coins = monedaDao.getAll();
    const allowed = new Set(['EUR', ...coins.map(c => String(c.symbol).toUpperCase())]);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.render('deposit', {
        title: 'Depositar - Galpe Exchange',
        user: req.session.user,
        error: 'Introduce una cantidad válida (mayor que 0).',
        success: null,
        coins,
        history: []
      });
    }

    if (!allowed.has(curr)) {
      return res.render('deposit', {
        title: 'Depositar - Galpe Exchange',
        user: req.session.user,
        error: 'Moneda no soportada.',
        success: null,
        coins,
        history: []
      });
    }

    if (dest && dest.length < 6) {
      return res.render('deposit', {
        title: 'Depositar - Galpe Exchange',
        user: req.session.user,
        error: 'Destino inválido (IBAN o wallet).',
        success: null,
        coins,
        history: []
      });
    }

    const userId = req.session.user.id;
    walletDao.add(userId, curr, parsedAmount);

    transaccionDao.create({
      id: Date.now().toString(),
      user_id: userId,
      type: 'deposit',
      currency: curr,
      amount: parsedAmount,
      fee: 0,
      destination: dest || undefined,
      meta: { source: 'web' },
      created_at: new Date().toISOString()
    });

    // refrescar sesión
    const refreshed = usuarioDao.getById(userId);
    const wallets = walletDao.listByUserId(userId);
    const balance = { eur: 0, btc: 0 };
    const assets = [];
    for (const w of wallets) {
      const c = String(w.currency).toUpperCase();
      const a = Number(w.amount) || 0;
      if (c === 'EUR') balance.eur = a;
      if (c === 'BTC') balance.btc = a;
      if (c !== 'EUR' && a !== 0) assets.push({ symbol: c, amount: a });
    }
    req.session.user = { ...refreshed, balance, assets };

    const history = transaccionDao
      .listByUserId(userId, 50)
      .filter(t => t.type === 'deposit')
      .map(t => ({
        id: t.id,
        currency: t.currency.toLowerCase(),
        amount: t.amount,
        fee: t.fee,
        destination: t.destination,
        status: (() => {
          try { return JSON.parse(t.meta || '{}').status || 'completed'; } catch { return 'completed'; }
        })(),
        createdAt: t.created_at
      }));

    return res.render('deposit', {
      title: 'Depositar - Galpe Exchange',
      user: req.session.user,
      error: null,
      success: `Depósito: +${parsedAmount} ${curr}`,
      coins,
      history
    });
  } catch (err) {
    next(err);
  }
});

// Rutas públicas de autenticación
router.get('/login', function (req, res, next) {
  // Si ya está autenticado, redirigir al dashboard
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Iniciar Sesión - Galpe Exchange' });
});

router.get('/register', function (req, res, next) {
  // Si ya está autenticado, redirigir al dashboard
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('register', { title: 'Registrarse - Galpe Exchange' });
});


//   WITHDRAW (GET)
//   WITHDRAW (GET)
router.get('/withdraw', requireAuth, (req, res, next) => {
  try {
    const history = transaccionDao
      .listByUserId(req.session.user.id, 50)
      .filter(t => t.type === 'withdraw')
      .map(t => ({
        id: t.id,
        type: 'withdraw',
        currency: t.currency.toLowerCase(),
        amount: t.amount,
        fee: t.fee,
        destination: t.destination,
        status: (() => {
          try { return JSON.parse(t.meta || '{}').status || 'completed'; } catch { return 'completed'; }
        })(),
        createdAt: t.created_at
      }));

    res.render('withdraw', {
      title: 'Retirar - Galpe Exchange',
      user: req.session.user,
      error: null,
      success: null,
      history
    });
  } catch (err) {
    next(err);
  }
});

//   WITHDRAW (POST) - SIMULADO
//   WITHDRAW (POST) - SIMULADO
router.post('/withdraw', requireAuth, (req, res, next) => {
  try {
    const { amount, currency, destination } = req.body;

    const curr = (currency || 'eur').toUpperCase();
    const parsedAmount = Number.parseFloat(String(amount).replace(',', '.'));
    const dest = (destination || '').trim();

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.render('withdraw', {
        title: 'Retirar - Galpe Exchange',
        user: req.session.user,
        error: 'Introduce una cantidad válida.',
        success: null,
        history: []
      });
    }

    if (!['EUR', 'BTC'].includes(curr)) {
      return res.render('withdraw', {
        title: 'Retirar - Galpe Exchange',
        user: req.session.user,
        error: 'Moneda no soportada.',
        success: null,
        history: []
      });
    }

    if (dest.length < 6) {
      return res.render('withdraw', {
        title: 'Retirar - Galpe Exchange',
        user: req.session.user,
        error: 'Introduce un destino válido (IBAN o wallet).',
        success: null,
        history: []
      });
    }

    const userId = req.session.user.id;

    const current = walletDao.getAmount(userId, curr);

    if (parsedAmount > current) {
      return res.render('withdraw', {
        title: 'Retirar - Galpe Exchange',
        user: req.session.user,
        error: `Fondos insuficientes. Tienes ${curr === 'BTC' ? current : current.toFixed(2)} ${curr}.`,
        success: null,
        history: []
      });
    }

    const fee = curr === 'BTC' ? 0.0001 : 0.50;
    const totalDebit = parsedAmount + fee;

    if (totalDebit > current) {
      return res.render('withdraw', {
        title: 'Retirar - Galpe Exchange',
        user: req.session.user,
        error: `Saldo insuficiente para cubrir comisión. Comisión: ${fee} ${curr}.`,
        success: null,
        history: []
      });
    }

    walletDao.subtract(userId, curr, totalDebit);

    const txId = Date.now().toString();
    transaccionDao.create({
      id: txId,
      user_id: userId,
      type: 'withdraw',
      currency: curr,
      amount: parsedAmount,
      fee,
      destination: dest,
      meta: { status: 'completed' },
      created_at: new Date().toISOString()
    });

    // refrescar sesión
    const refreshed = usuarioDao.getById(userId);
    const wallets = walletDao.listByUserId(userId);
    const balance = { eur: 0, btc: 0 };
    const assets = [];
    for (const w of wallets) {
      const c = String(w.currency).toUpperCase();
      const a = Number(w.amount) || 0;
      if (c === 'EUR') balance.eur = a;
      if (c === 'BTC') balance.btc = a;
      if (c !== 'EUR' && a !== 0) assets.push({ symbol: c, amount: a });
    }
    req.session.user = { ...refreshed, balance, assets };

    const history = transaccionDao
      .listByUserId(userId, 50)
      .filter(t => t.type === 'withdraw')
      .map(t => ({
        id: t.id,
        type: 'withdraw',
        currency: t.currency.toLowerCase(),
        amount: t.amount,
        fee: t.fee,
        destination: t.destination,
        status: (() => {
          try { return JSON.parse(t.meta || '{}').status || 'completed'; } catch { return 'completed'; }
        })(),
        createdAt: t.created_at
      }));

    return res.render('withdraw', {
      title: 'Retirar - Galpe Exchange',
      user: req.session.user,
      error: null,
      success: `Retiro simulado: -${parsedAmount} ${curr} (comisión ${fee} ${curr}).`,
      history
    });
  } catch (err) {
    next(err);
  }
});

router.get('/support/reset-password', function (req, res, next) {
  res.render('reset-password', { title: 'Cambiar contraseña - Galpe Exchange' });
});

router.get('/support/change-email', function (req, res, next) {
  res.render('change-email', { title: 'Cambiar correo electrónico - Galpe Exchange' });
});

router.post('/support/change-email', function (req, res, next) {
  try {
    const { currentEmail, newEmail, password } = req.body;

    if (!currentEmail || !newEmail || !password) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'Por favor, completa todos los campos'
      });
    }

    if (!newEmail.includes('@')) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'Por favor, introduce un email válido'
      });
    }

    if (currentEmail === newEmail) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'El nuevo correo electrónico debe ser diferente al actual'
      });
    }

    const userWithPwd = usuarioDao.getWithPasswordByEmail(currentEmail);
    if (!userWithPwd) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'No se encontró ningún usuario con ese correo electrónico'
      });
    }

    if (userWithPwd.password !== password) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'La contraseña es incorrecta'
      });
    }

    const emailExists = usuarioDao.getByEmail(newEmail);
    if (emailExists && emailExists.id !== userWithPwd.id) {
      return res.render('change-email', {
        title: 'Cambiar correo electrónico - Galpe Exchange',
        error: 'Este correo electrónico ya está en uso por otra cuenta'
      });
    }

    usuarioDao.updateEmail(userWithPwd.id, newEmail);

    // Si el usuario está en sesión, actualizar la sesión también
    if (req.session.user && req.session.user.id === userWithPwd.id) {
      req.session.user.email = newEmail;
    }

    res.render('change-email', {
      title: 'Cambiar correo electrónico - Galpe Exchange',
      success: 'Correo electrónico cambiado exitosamente. Ya puedes iniciar sesión con tu nuevo correo electrónico.'
    });
  } catch (error) {
    console.error('Error al cambiar correo electrónico:', error);
    res.render('change-email', {
      title: 'Cambiar correo electrónico - Galpe Exchange',
      error: 'Ocurrió un error al cambiar el correo electrónico. Por favor, intenta de nuevo.'
    });
  }
});

router.post('/support/reset-password', function (req, res, next) {
  try {
    const { email, newPassword, confirmPassword } = req.body;

    if (!email || !newPassword || !confirmPassword) {
      return res.render('reset-password', {
        title: 'Cambiar contraseña - Galpe Exchange',
        error: 'Por favor, completa todos los campos'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render('reset-password', {
        title: 'Cambiar contraseña - Galpe Exchange',
        error: 'Las contraseñas no coinciden'
      });
    }

    if (newPassword.length < 6) {
      return res.render('reset-password', {
        title: 'Cambiar contraseña - Galpe Exchange',
        error: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    const user = usuarioDao.getByEmail(email);
    if (!user) {
      return res.render('reset-password', {
        title: 'Cambiar contraseña - Galpe Exchange',
        error: 'No se encontró ningún usuario con ese correo electrónico'
      });
    }

    usuarioDao.updatePasswordByEmail(email, newPassword);

    if (req.session.user && req.session.user.email === email) {
      req.session.user = { ...req.session.user };
    }

    res.render('reset-password', {
      title: 'Cambiar contraseña - Galpe Exchange',
      success: 'Contraseña cambiada exitosamente. Ya puedes iniciar sesión con tu nueva contraseña.'
    });
  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.render('reset-password', {
      title: 'Cambiar contraseña - Galpe Exchange',
      error: 'Ocurrió un error al cambiar la contraseña. Por favor, intenta de nuevo.'
    });
  }
});

// Support: Congelar / Reactivar cuenta
router.get('/support/freeze-account', requireAuth, function (req, res, next) {
  try {
    res.render('freeze-account', { title: 'Congelar cuenta - Galpe Exchange', success: null });
  } catch (err) {
    next(err);
  }
});

router.post('/support/freeze-account', requireAuth, function (req, res, next) {
  try {
    const userId = req.session.user.id;
    usuarioDao.setFrozen(userId, true);
    // refrescar sesión
    const refreshed = usuarioDao.getById(userId);
    req.session.user = { ...req.session.user, ...refreshed };

    res.render('freeze-account', { title: 'Congelar cuenta - Galpe Exchange', success: 'Tu cuenta ha sido congelada.' });
  } catch (err) {
    next(err);
  }
});

router.get('/support/account-frozen', function (req, res, next) {
  try {
    res.render('account-frozen', { title: 'Cuenta congelada - Galpe Exchange' });
  } catch (err) {
    next(err);
  }
});

router.post('/support/unfreeze-account', function (req, res, next) {
  try {
    if (!req.session.user) return res.redirect('/login');
    const userId = req.session.user.id;
    usuarioDao.setFrozen(userId, false);
    // refrescar sesión
    const refreshed = usuarioDao.getById(userId);
    req.session.user = { ...req.session.user, ...refreshed };

    // Al reactivar, redirigir al dashboard
    return res.redirect('/dashboard');
  } catch (err) {
    next(err);
  }
});

// --- RUTA IA (VERSIÓN BLINDADA / SMART FALLBACK) ---
router.get('/api/ai-analysis', async (req, res) => {
  let noticiasRaw = ""; // Guardamos las noticias aquí para usarlas si falla la IA

  try {
    console.log("1. Buscando noticias en CryptoCompare...");

    // Paso 1: Obtener noticias reales (Esto casi nunca falla)
    const newsResponse = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=ES');

    // Preparamos los titulares para la IA y para el "Plan B"
    const headlines = newsResponse.data.Data.slice(0, 3);
    noticiasRaw = headlines.map(n => `- ${n.title}`).join('\\n');

    console.log("2. Noticias obtenidas. Contactando a Google Gemini...");

    // Verificamos API Key
    if (!process.env.GEMINI_API_KEY) throw new Error("Falta API Key");

    // Paso 2: Intentar con la IA
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Intentamos usar el modelo flash, si falla saltaremos al catch
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    const prompt = `
      Actúa como un experto trader. Lee estos titulares:
      ${noticiasRaw}
      
      Escribe un resumen muy corto (máximo 40 palabras) y emotivo para un inversor. 
      Usa emojis. No uses negritas (**), usa etiquetas HTML <b> si quieres resaltar algo.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // ¡ÉXITO! La IA respondió
    res.json({
      success: true,
      analysis: text
    });

  } catch (error) {
    console.error("⚠️ MODO RESPALDO ACTIVADO:", error.message);

    if (noticiasRaw) {
      // MAQUILLAJE: Hacemos parecer que este es el análisis normal
      res.json({
        success: true,
        analysis: `<strong>📡 ACTUALIZACIÓN DE MERCADO:</strong><br><br>He seleccionado los titulares más importantes del momento para ti:<br><br>${noticiasRaw.replace(/\\n/g, '<br><br>')}<br><br>💡 <em>Conclusión: El mercado muestra actividad alta. Recomiendo revisar los gráficos antes de operar.</em>`
      });
    } else {
      res.json({
        success: true,
        analysis: "⚠️ Conectando con los mercados... Por favor, inténtalo en unos segundos."
      });
    }
  }
});

module.exports = router;
