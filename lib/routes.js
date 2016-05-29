'use strict'

var BigNumber = require('bignumber.js')
var logger = require('./logger')
const pairer = require('./pairer')

var mock = false

var plugins

module.exports = {
  init: init,
  getFingerprint: getFingerprint
}

var STALE_TICKER = 10 * 60 * 1000
var STALE_BALANCE = 10 * 60 * 1000

var pids = {}
var reboots = {}

function buildRates () {
  var cryptoCodes = plugins.getcryptoCodes()
  var config = plugins.getConfig()
  var settings = config.exchanges.settings

  var cashInCommission = settings.commission
  var cashOutCommission = settings.fiatCommission || cashInCommission

  var rates = {}
  cryptoCodes.forEach(function (cryptoCode) {
    var _rate = plugins.getDeviceRate(cryptoCode)
    if (!_rate) return logger.warn('No rate for ' + cryptoCode + ' yet')
    if (Date.now() - _rate.timestamp > STALE_TICKER) return logger.warn('Stale rate for ' + cryptoCode)
    var rate = _rate.rates
    rates[cryptoCode] = {
      cashIn: rate.ask.times(cashInCommission),
      cashOut: rate.bid.div(cashOutCommission)
    }
  })

  return rates
}

function buildBalances () {
  var cryptoCodes = plugins.getcryptoCodes()

  var _balances = {}
  cryptoCodes.forEach(function (cryptoCode) {
    var balance = plugins.fiatBalance(cryptoCode)
    if (!balance) return logger.warn('No balance for ' + cryptoCode + ' yet')
    if (Date.now() - balance.timestamp > STALE_BALANCE) return logger.warn('Stale balance for ' + cryptoCode)
    _balances[cryptoCode] = balance
  })

  return _balances
}

function poll (req, res) {
  var fingerprint = getFingerprint(req)
  var pid = req.query.pid

  pids[fingerprint] = {pid: pid, ts: Date.now()}

  logger.debug('poll request from: %s', fingerprint)

  var rates = {}
  var balances = {}

  rates = buildRates()
  balances = buildBalances()

  var config = plugins.getConfig()
  var settings = config.exchanges.settings
  var complianceSettings = settings.compliance

  plugins.pollQueries(session(req))
  .then(results => {
    var cartridges = results.cartridges

    var reboot = reboots[fingerprint] === pid

    var response = {
      err: null,
      locale: config.brain.locale,
      txLimit: parseInt(complianceSettings.maximum.limit, 10),
      idVerificationEnabled: complianceSettings.idVerificationEnabled,
      cartridges: cartridges,
      twoWayMode: !!cartridges,
      zeroConfLimit: settings.zeroConfLimit,
      fiatTxLimit: settings.fiatTxLimit,
      reboot: reboot,
      rates: rates,
      balances: balances,
      coins: settings.coins
    }

    if (response.idVerificationEnabled) {
      response.idVerificationLimit = complianceSettings.idVerificationLimit
    }

    res.json(response)
  })
  .catch(logger.error)

  plugins.recordPing(session(req), req.query)
  .catch(logger.error)
}

function trade (req, res) {
  var tx = req.body
  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  plugins.trade(session(req), tx)
  .then(() => res.status(201).json({}))
  .catch(err => {
    logger.error(err)
    res.status(500).json({err: err})
  })
}

function stateChange (req, res) {
  plugins.stateChange(session(req), req.body)
  .then(() => res.json({success: true}))
  .catch(err => {
    console.error(err)
    res.json({success: false})
  })
}

function send (req, res) {
  var tx = req.body
  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  plugins.sendCoins(session(req), tx, function (err, status) {
    // TODO: use status.statusCode here after confirming machine compatibility
    // FIX: (joshm) set txHash to status.txId instead of previous status.txHash which wasn't being set
    // Need to clean up txHash vs txId
    res.json({
      errType: err && err.name,
      err: err && err.message,
      txHash: status && status.txHash,
      txId: status && status.txId
    })
  })
}

function cashOut (req, res) {
  logger.info({tx: req.body, cmd: 'cashOut'})
  var tx = req.body
  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  return plugins.cashOut(session(req), req.body)
  .then(cryptoAddress => res.json({bitcoinAddress: cryptoAddress}))
  .catch(err => {
    res.json({
      err: err.message,
      errType: err.name
    })
    logger.error(err)
  })
}

function dispenseAck (req, res) {
  plugins.dispenseAck(session(req), req.body)
  res.json({success: true})
}

function deviceEvent (req, res) {
  plugins.logEvent(session(req), req.body)
  res.json({err: null})
}

function verifyUser (req, res) {
  if (mock) return res.json({success: true})

  plugins.verifyUser(req.body, function (err, idResult) {
    if (err) {
      logger.error(err)
      return res.json({err: 'Verification failed'})
    }

    res.json(idResult)
  })
}

function verifyTx (req, res) {
  if (mock) return res.json({success: true})

  plugins.verifyTx(req.body, function (err, idResult) {
    if (err) {
      logger.error(err)
      return res.json({err: 'Verification failed'})
    }

    res.json(idResult)
  })
}

function pair (req, res) {
  const token = req.body.token
  const csr = req.body.csr
  const hmac = req.body.hmac

  pairer.pair(token, csr, hmac)
  .then(r => res.json({certificate: r.certificate, ca: r.ca}))
  .catch(err => res.json({err: err}))
}

function phoneCode (req, res) {
  var phone = req.body.phone

  logger.debug('Phone code requested for: ' + phone)
  return plugins.getPhoneCode(phone)
  .then(code => res.json({code: code}))
  .catch(err => {
    logger.error(err)
    if (err.name === 'BadNumberError') return res.sendStatus(410)
    return res.sendStatus(500)
  })
}

function updatePhone (req, res) {
  const notified = req.query.notified === 'true'
  return plugins.updatePhone(session(req), req.body, notified)
  .then(r => res.json(r))
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
}

function fetchPhoneTx (req, res) {
  return plugins.fetchPhoneTx(req.query.phone)
  .then(r => res.json(r))
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
}

function registerRedeem (req, res) {
  return plugins.registerRedeem(session(req))
  .then(() => res.json({success: true}))
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
}

function waitForDispense (req, res) {
  logger.debug('waitForDispense')
  return plugins.fetchTx(session(req))
  .then(tx => {
    logger.debug('tx fetched')
    logger.debug(tx)
    if (!tx) return res.sendStatus(404)
    if (tx.status === req.query.status) return res.sendStatus(304)
    res.json({tx: tx})
  })
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
}

function dispense (req, res) {
  const tx = req.body.tx

  return plugins.requestDispense(tx)
  .then(r => {
    return cacheResponse(req, r)
    .then(() => res.json(r))
  })
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
}

function init (localConfig) {
  plugins = localConfig.plugins
  mock = localConfig.mock

  var authMiddleware = localConfig.authMiddleware
  var app = localConfig.app
  var localApp = localConfig.localApp

  app.get('/poll', authMiddleware, poll)

  app.post('/trade', authMiddleware, trade)
  app.post('/send', authMiddleware, send)
  app.post('/state', authMiddleware, stateChange)
  app.post('/cash_out', authMiddleware, cashOut)
  app.post('/dispense_ack', authMiddleware, dispenseAck)

  app.post('/event', authMiddleware, deviceEvent)
  app.post('/verify_user', authMiddleware, verifyUser)
  app.post('/verify_transaction', authMiddleware, verifyTx)
  app.post('/pair', pair)

  app.post('/phone_code', authMiddleware, phoneCode)
  app.post('/update_phone', authMiddleware, updatePhone)
  app.get('/phone_tx', authMiddleware, fetchPhoneTx)
  app.post('/register_redeem', authMiddleware, registerRedeem)
  app.get('/await_dispense', authMiddleware, waitForDispense)
  app.post('/dispense', authMiddleware, cachedResponse, dispense)

  localApp.get('/pid', function (req, res) {
    var machineFingerprint = req.query.fingerprint
    var pidRec = pids[machineFingerprint]
    res.json(pidRec)
  })

  localApp.post('/reboot', function (req, res) {
    var pid = req.body.pid
    var fingerprint = req.body.fingerprint
    console.log('pid: %s, fingerprint: %s', pid, fingerprint)

    if (!fingerprint || !pid) {
      return res.sendStatus(400)
    }

    reboots[fingerprint] = pid
    res.sendStatus({success: true})
  })

  return app
}

function session (req) {
  return {
    fingerprint: getFingerprint(req),
    id: req.get('session-id'),
    deviceTime: Date.parse(req.get('date'))
  }
}

function getFingerprint (req) {
  return (typeof req.connection.getPeerCertificate === 'function' &&
  req.connection.getPeerCertificate().fingerprint) || 'unknown'
}

function cachedResponse (req, res, next) {
  return plugins.cachedResponse(session(req), req.path, req.method)
  .then(r => {
    if (!r.body) return next()
    if (r.body.pendingRequest) return res.sendStatus(409)
    res.json(r.body)
  })
}

function cacheResponse (req, body) {
  return plugins.cacheResponse(session(req), req.path, req.method, body)
}
