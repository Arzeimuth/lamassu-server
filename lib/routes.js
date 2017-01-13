'use strict'

const morgan = require('morgan')
const helmet = require('helmet')
const bodyParser = require('body-parser')
const BigNumber = require('bignumber.js')
const _ = require('lodash/fp')
const express = require('express')

const options = require('./options')
const logger = require('./logger')
const configManager = require('./config-manager')
const db = require('./db')
const dbm = require('./postgresql_interface')
const pairing = require('./pairing')
const settingsLoader = require('./settings-loader')
const plugins = require('./plugins')
const helpers = require('./route-helpers')
const poller = require('./poller')
const argv = require('minimist')(process.argv.slice(2))

const CLOCK_SKEW = 60 * 1000
const REQUEST_TTL = 3 * 60 * 1000

const pids = {}
const reboots = {}

const devMode = argv.dev || options.http

function poll (req, res, next) {
  const deviceId = req.deviceId
  const deviceTime = req.deviceTime
  const pid = req.query.pid
  const settings = req.settings
  const config = configManager.machineScoped(deviceId, settings.config)
  const pi = plugins(settings)

  pids[deviceId] = {pid, ts: Date.now()}

  pi.pollQueries(deviceTime, deviceId, req.query)
  .then(results => {
    const cartridges = results.cartridges

    console.log('DEBUG22: %j', cartridges)
    const reboot = pid && reboots[deviceId] && reboots[deviceId] === pid
    const langs = config.machineLanguages

    const locale = {
      fiatCode: config.fiatCurrency,
      localeInfo: {
        primaryLocale: langs[0],
        primaryLocales: langs,
        country: config.country
      }
    }

    const response = {
      err: null,
      locale,
      txLimit: config.cashInTransactionLimit,
      idVerificationEnabled: config.idVerificationEnabled,
      smsVerificationEnabled: config.smsVerificationEnabled,
      cartridges,
      twoWayMode: config.cashOutEnabled,
      zeroConfLimit: config.zeroConfLimit,
      fiatTxLimit: config.cashOutTransactionLimit,
      reboot,
      rates: results.rates,
      balances: results.balances,
      coins: config.cryptoCurrencies,
      configVersion: results.currentConfigVersion
    }

    if (response.idVerificationEnabled) {
      response.idVerificationLimit = config.idVerificationLimit
    }

    return res.json(response)
  })
  .catch(next)
}

function trade (req, res, next) {
  const tx = req.body
  const pi = plugins(req.settings)

  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  pi.trade(req.deviceId, tx)
  .then(() => cacheAndRespond(req, res))
  .catch(next)
}

function stateChange (req, res, next) {
  helpers.stateChange(req.deviceId, req.deviceTime, req.body)
  .then(() => cacheAndRespond(req, res))
  .catch(next)
}

function send (req, res, next) {
  const pi = plugins(req.settings)
  const tx = req.body
  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  return pi.sendCoins(req.deviceId, tx)
  .then(status => {
    const body = {txId: status && status.txId}
    return cacheAndRespond(req, res, body)
  })
  .catch(next)
}

function cashOut (req, res, next) {
  const pi = plugins(req.settings)
  logger.info({tx: req.body, cmd: 'cashOut'})
  const tx = req.body
  tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

  return pi.cashOut(req.deviceId, tx)
  .then(cryptoAddress => cacheAndRespond(req, res, {toAddress: cryptoAddress}))
  .catch(next)
}

function dispenseAck (req, res, next) {
  const pi = plugins(req.settings)
  pi.dispenseAck(req.deviceId, req.body.tx)
  .then(() => cacheAndRespond(req, res))
  .catch(next)
}

function deviceEvent (req, res, next) {
  const pi = plugins(req.settings)
  pi.logEvent(req.deviceId, req.body)
  .then(() => cacheAndRespond(req, res))
  .catch(next)
}

function verifyUser (req, res, next) {
  const pi = plugins(req.settings)
  pi.verifyUser(req.body)
  .then(idResult => cacheAndRespond(req, res, idResult))
  .catch(next)
}

function verifyTx (req, res, next) {
  const pi = plugins(req.settings)
  pi.verifyTransaction(req.body)
  .then(idResult => cacheAndRespond(req, res, idResult))
  .catch(next)
}

function ca (req, res) {
  const token = req.query.token

  return pairing.authorizeCaDownload(token)
  .then(ca => res.json({ca}))
  .catch(() => res.sendStatus(403))
}

function pair (req, res, next) {
  const token = req.query.token
  const deviceId = req.deviceId

  return pairing.pair(token, deviceId)
  .then(valid => {
    if (valid) return res.end()
    throw httpError('Pairing failed')
  })
  .catch(next)
}

function phoneCode (req, res, next) {
  const pi = plugins(req.settings)
  const phone = req.body.phone

  return pi.getPhoneCode(phone)
  .then(code => cacheAndRespond(req, res, {code}))
  .catch(err => {
    if (err.name === 'BadNumberError') throw httpError('Bad number', 410)
    throw err
  })
  .catch(next)
}

function updatePhone (req, res, next) {
  const notified = req.query.notified === 'true'
  const tx = req.body

  return dbm.updatePhone(tx, notified)
  .then(r => cacheAndRespond(req, res, r))
  .catch(next)
}

function fetchPhoneTx (req, res, next) {
  return helpers.fetchPhoneTx(req.query.phone)
  .then(r => res.json(r))
  .catch(next)
}

function registerRedeem (req, res, next) {
  const txId = req.params.txId
  return dbm.registerRedeem(txId)
  .then(() => cacheAndRespond(req, res))
  .catch(next)
}

function waitForDispense (req, res, next) {
  logger.debug('waitForDispense')
  return dbm.fetchTx(req.params.txId)
  .then(tx => {
    logger.debug('tx fetched')
    logger.debug(tx)
    if (!tx) return res.sendStatus(404)
    if (tx.status === req.query.status) return res.sendStatus(304)
    res.json({tx})
  })
  .catch(next)
}

function dispense (req, res, next) {
  const tx = req.body.tx

  return dbm.addDispenseRequest(tx)
  .then(dispenseRec => cacheAndRespond(req, res, dispenseRec))
  .catch(next)
}

function isUniqueViolation (err) {
  return err.code === '23505'
}

function cacheAction (req, res, next) {
  const requestId = req.headers['request-id']
  if (!requestId) return next()

  const sql = `insert into idempotents (request_id, device_id, body, status, pending)
  values ($1, $2, $3, $4, $5)`

  const deviceId = req.deviceId

  db.none(sql, [requestId, deviceId, {}, 204, true])
  .then(() => next())
  .catch(err => {
    if (!isUniqueViolation(err)) throw err

    const sql2 = 'select body, status, pending from idempotents where request_id=$1'
    return db.one(sql2, [requestId])
    .then(row => {
      if (row.pending) return res.status(204).end()
      return res.status(row.status).json(row.body)
    })
  })
}

function updateCachedAction (req, body, status) {
  const requestId = req.headers['request-id']
  if (!requestId) return Promise.resolve()

  const sql = `update idempotents set body=$1, status=$2, pending=$3
  where request_id=$4 and device_id=$5 and pending=$6`

  const deviceId = req.deviceId

  return db.none(sql, [body, status, false, requestId, deviceId, true])
}

function errorHandler (err, req, res, next) {
  const statusCode = err.name === 'HttpError'
  ? err.code || 500
  : 500

  const json = {error: err.message}

  logger.error(err)

  return updateCachedAction(req, json, statusCode)
  .then(() => res.status(statusCode).json(json))
}

function cacheAndRespond (req, res, _body, _status) {
  const status = _status || 200
  const body = _body || {}

  return updateCachedAction(req, body, status)
  .then(() => res.status(status).json(body))
}

function pruneIdempotents () {
  const sql = "delete from idempotents where created < now() - interval '24 hours'"

  return db.none(sql)
}

function httpError (msg, code) {
  const err = new Error(msg)
  err.name = 'HTTPError'
  err.code = code || 500

  return err
}

function filterOldRequests (req, res, next) {
  const deviceTime = req.deviceTime
  const delta = Date.now() - deviceTime

  if (delta > CLOCK_SKEW) {
    logger.error('Clock skew with lamassu-machine too high [%ss], adjust lamassu-machine clock', (delta / 1000).toFixed(2))
  }

  if (delta > REQUEST_TTL) return res.status(408).end()
  next()
}

function authorize (req, res, next) {
  const deviceId = req.deviceId

  return pairing.isPaired(deviceId)
  .then(r => {
    if (r) {
      req.deviceId = deviceId
      return next()
    }

    return res.sendStatus(403)
  })
  .catch(next)
}

const skip = options.logLevel === 'debug'
? () => false
: (req, res) => _.includes(req.path, ['/poll', '/state']) && res.statusCode === 200

const configRequiredRoutes = [
  '/poll',
  '/trade',
  '/send',
  '/cash_out',
  '/dispense_ack',
  '/event',
  '/verify_user',
  '/verify_transaction',
  '/phone_code'
]

const app = express()
const localApp = express()

app.use(helmet({noCache: true}))
app.use(bodyParser.json())
app.use(morgan('dev', {skip}))

// These two have their own authorization
app.post('/pair', populateDeviceId, pair)
app.get('/ca', ca)

app.use(populateDeviceId)
if (!devMode) app.use(authorize)
app.use(configRequiredRoutes, populateSettings)
app.use(filterOldRequests)
app.post('*', cacheAction)

app.get('/poll', poll)
app.post('/trade', trade)
app.post('/send', send)
app.post('/state', stateChange)
app.post('/cash_out', cashOut)
app.post('/dispense_ack', dispenseAck)

app.post('/event', deviceEvent)
app.post('/verify_user', verifyUser)
app.post('/verify_transaction', verifyTx)

app.post('/phone_code', phoneCode)
app.post('/update_phone', updatePhone)
app.get('/phone_tx', fetchPhoneTx)
app.post('/register_redeem/:txId', registerRedeem)
app.get('/await_dispense/:txId', waitForDispense)
app.post('/dispense', dispense)

app.use(errorHandler)

localApp.get('/pid', (req, res) => {
  const deviceId = req.query.device_id
  const pidRec = pids[deviceId]
  res.json(pidRec)
})

localApp.post('/reboot', (req, res) => {
  const pid = req.body.pid
  const deviceId = req.body.deviceId

  if (!deviceId || !pid) {
    return res.sendStatus(400)
  }

  reboots[deviceId] = pid
  res.sendStatus(200)
})

localApp.post('/dbChange', (req, res, next) => {
  return settingsLoader.loadLatest()
  .then(poller.reload)
  .then(() => logger.info('Config reloaded'))
  .catch(err => {
    logger.error(err)
    res.sendStatus(500)
  })
})

function populateDeviceId (req, res, next) {
  const deviceId = ((typeof req.connection.getPeerCertificate === 'function' &&
  req.connection.getPeerCertificate().fingerprint)) || null

  req.deviceId = deviceId
  req.deviceTime = Date.parse(req.get('date'))

  next()
}

function populateSettings (req, res, next) {
  const versionId = req.headers['config-version']
  logger.debug('versionId: %s', versionId)

  if (!versionId) {
    return settingsLoader.loadLatest()
    .then(settings => { req.settings = settings })
    .then(() => next())
    .catch(next)
  }

  settingsLoader.load(versionId)
  .then(settings => { req.settings = settings })
  .then(() => helpers.updateDeviceConfigVersion(versionId))
  .then(() => next())
  .catch(next)
}

setInterval(pruneIdempotents, 60000)

module.exports = {app, localApp}
