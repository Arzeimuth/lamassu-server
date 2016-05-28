'use strict'

// TODO: Consider using serializable transactions for true ACID

var BigNumber = require('bignumber.js')
var pg = require('pg')
var async = require('async')
var R = require('ramda')

var logger = require('./logger')

const CACHED_SESSION_TTL = 60 * 60 * 1000

/*
function inspect(rec) {
  console.log(require('util').inspect(rec, {depth: null, colors: true}))
}
*/

function isUniqueViolation (err) {
  return err.code === '23505'
}

function isLowSeverity (err) {
  return isUniqueViolation(err) || err.severity === 'low'
}

var conString = null

function rollback (client, done) {
  client.query('ROLLBACK', function (err) {
    return done(err)
  })
}

function getInsertQuery (tableName, fields, hasId) {
  // outputs string like: '$1, $2, $3...' with proper No of items
  var placeholders = fields.map(function (_, i) {
    return '$' + (i + 1)
  }).join(', ')

  var query = 'INSERT INTO ' + tableName +
    ' (' + fields.join(', ') + ')' +
    ' VALUES' +
    ' (' + placeholders + ')'

  if (hasId) query += ' RETURNING id'

  return query
}

exports.init = function init (_conString) {
  conString = _conString
  if (!conString) {
    throw new Error('Postgres connection string is required')
  }

  setInterval(pruneCachedResponses, CACHED_SESSION_TTL)
}

function connect (cb) {
  pg.connect(conString, function (err, client, done) {
    if (err) logger.error(err)
    cb(err, client, done)
  })
}

// logs inputted bill and overall tx status (if available)
exports.recordBill = function recordBill (session, rec, cb) {
  var fields = [
    'id',
    'device_fingerprint',
    'currency_code',
    'crypto_code',
    'to_address',
    'session_id',
    'device_time',
    'satoshis',
    'denomination'
  ]

  var values = [
    rec.uuid,
    session.fingerprint,
    rec.currency,
    rec.cryptoCode,
    rec.toAddress,
    session.id,
    rec.deviceTime,
    rec.cryptoAtoms.toString(),
    rec.fiat
  ]

  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    query(client, getInsertQuery('bills', fields, false), values, function (err) {
      done()
      if (err && isUniqueViolation(err)) {
        logger.warn('Attempt to report bill twice')
        return cb()
      }
      cb(err)
    })
  })
}

exports.recordDeviceEvent = function recordDeviceEvent (session, event) {
  connect(function (cerr, client, done) {
    if (cerr) return
    var sql = 'INSERT INTO device_events (device_fingerprint, event_type, ' +
      'note, device_time) VALUES ($1, $2, $3, $4)'
    var values = [session.fingerprint, event.eventType, event.note,
      event.deviceTime]
    client.query(sql, values, done)
  })
}

function query (client, queryStr, values, cb) {
  if (!cb) {
    cb = values
    values = []
  }

  client.query(queryStr, values, function (err, results) {
    if (err) {
      if (!isLowSeverity(err)) {
        console.error(err)
        console.log(queryStr)
        console.log(values)
      }
      return cb(err)
    }
    cb(null, results)
  })
}

function silentQuery (client, queryStr, values, cb) {
  if (!cb) {
    cb = values
    values = []
  }

  client.query(queryStr, values, function (err) {
    if (err) {
      if (!isLowSeverity(err)) {
        console.error(err)
        console.log(queryStr)
        console.log(values)
      }
      cb(err)
    }
    cb()
  })
}

function insertOutgoingCompleteTx (client, session, tx, cb) {
  // Only relevant for machine source transactions, not timeouts
  if (!tx.fiat) return cb()

  var stage = 'final_request'
  var authority = 'machine'
  var cryptoAtoms = tx.cryptoAtoms
  var fiat = tx.fiat
  insertOutgoing(client, session, tx, cryptoAtoms, fiat, stage, authority, cb)
}

function insertIncoming (client, session, tx, cryptoAtoms, fiat, stage, authority, cb) {
  var realCryptoAtoms = cryptoAtoms || new BigNumber(0)
  insertTx(client, session, true, tx, realCryptoAtoms, fiat, stage, authority, cb)
}

function insertOutgoing (client, session, tx, cryptoAtoms, fiat, stage, authority,
  cb) {
  insertTx(client, session, false, tx, cryptoAtoms, fiat, stage, authority, cb)
}

function insertTx (client, session, incoming, tx, cryptoAtoms, fiat, stage,
  authority, cb) {
  logger.debug('connected in insertTx')

  var fields = [
    'session_id',
    'stage',
    'authority',
    'incoming',
    'device_fingerprint',
    'to_address',
    'satoshis',
    'currency_code',
    'crypto_code',
    'fiat',
    'tx_hash',
    'phone',
    'error'
  ]

  var values = [
    session.id,
    stage,
    authority,
    incoming,
    session.fingerprint,
    tx.toAddress,
    cryptoAtoms.toString(),
    tx.currencyCode,
    tx.cryptoCode,
    fiat,
    tx.txHash,
    tx.phone,
    tx.error
  ]

  query(client, getInsertQuery('transactions', fields, true), values,
    function (err, results) {
      logger.debug('in insertTx query')
      if (err) return cb(err)
      logger.debug('in insertTx query, doing callback')
      cb(null, results.rows[0].id)
    })
}

function addPendingTx (client, session, incoming, currencyCode, cryptoCode, toAddress,
  cryptoAtoms, cb) {
  var fields = ['device_fingerprint', 'session_id', 'incoming',
    'currency_code', 'crypto_code', 'to_address', 'satoshis']
  var sql = getInsertQuery('pending_transactions', fields, false)
  var values = [session.fingerprint, session.id, incoming, currencyCode,
    cryptoCode, toAddress, cryptoAtoms.toString()]
  query(client, sql, values, function (err) {
    cb(err)
  })
}

// Calling function should only send bitcoins if result.cryptoAtomsToSend > 0
exports.addOutgoingTx = function addOutgoingTx (session, tx, cb) {
  logger.debug('in addOutgoingTx')
  connect(function (cerr, client, done) {
    logger.debug('connected in addOutgoingTx')

    if (cerr) return cb(cerr)
    insertOutgoingCompleteTx(client, session, tx, cb)
  })
}

exports.sentCoins = function sentCoins (session, tx, authority, toSend, fee,
  error, txHash) {
  connect(function (cerr, client, done) {
    if (cerr) return logger.error(cerr)

    var newTx = R.clone(tx)
    newTx.txHash = txHash
    newTx.error = error
    insertOutgoing(client, session, newTx, toSend.cryptoAtoms, toSend.fiat,
      'partial_send', authority, function (err) {
        done()
        if (err) logger.error(err)
      })
  })
}

exports.addInitialIncoming = function addInitialIncoming (session, tx, cb) {
  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    async.series([
      async.apply(silentQuery, client, 'BEGIN', null),
      async.apply(addPendingTx, client, session, true, tx.currencyCode,
        tx.cryptoCode, tx.toAddress, tx.cryptoAtoms),
      async.apply(insertIncoming, client, session, tx, tx.cryptoAtoms, tx.fiat,
        'initial_request', 'pending')
    ], function (err) {
      if (err) {
        rollback(client, done)
        return cb(err)
      }
      silentQuery(client, 'COMMIT', null, function () {
        done()
        cb()
      })
    })
  })
}

function insertDispense (client, session, tx, cartridges, transactionId, cb) {
  var fields = [
    'device_fingerprint', 'transaction_id',
    'dispense1', 'reject1', 'count1',
    'dispense2', 'reject2', 'count2',
    'refill', 'error'
  ]

  var sql = getInsertQuery('dispenses', fields, true)

  var dispense1 = tx.bills[0].actualDispense
  var dispense2 = tx.bills[1].actualDispense
  var reject1 = tx.bills[0].rejected
  var reject2 = tx.bills[1].rejected
  var count1 = cartridges[0].count
  var count2 = cartridges[1].count
  var values = [
    session.fingerprint, transactionId,
    dispense1, reject1, count1, dispense2, reject2, count2,
    false, tx.error
  ]
  client.query(sql, values, cb)
}

exports.addIncomingPhone = function addIncomingPhone (session, tx, notified, cb) {
  var sql = 'UPDATE transactions SET phone=$1, notified=$2 ' +
    'WHERE incoming=$3 AND device_fingerprint=$4 AND session_id=$5 ' +
    'AND stage=$6 AND authority=$7 AND phone IS NULL'

  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)
      var values = [tx.phone, notified, true, session.fingerprint,
        tx.sessionId, 'initial_request', 'pending']
      query(client, sql, values, function (err, results) {
        done(err)
        if (err) return reject(err)
        resolve({noPhone: results.rowCount === 0})
      })
    })
  })
}

function normalizeTxs (txs) {
  return txs.map(function (tx) {
    tx.toAddress = tx.to_address
    tx.currencyCode = tx.currency_code
    tx.txHash = tx.tx_hash
    tx.cryptoCode = tx.crypto_code
    tx.cryptoAtoms = new BigNumber(tx.satoshis)
    tx.sessionId = tx.session_id

    tx.to_address = undefined
    tx.currency_code = undefined
    tx.tx_hash = undefined
    tx.crypto_code = undefined
    tx.satoshis = undefined
    tx.session_id = undefined

    return tx
  })
}

exports.fetchPhoneTxs = function fetchPhoneTxs (phone, dispenseTimeout) {
  var sql = 'SELECT * FROM transactions ' +
    'WHERE phone=$1 AND dispensed=$2 ' +
    'AND (EXTRACT(EPOCH FROM (COALESCE(confirmation_time, now()) - created))) * 1000 < $3 ' +
    'AND stage=$4 AND authority=$5 AND incoming=$6'

  var values = [phone, false, dispenseTimeout, 'initial_request', 'pending', true]

  return pquery(sql, values)
  .then(r => normalizeTxs(r.rows))
}

exports.fetchTx = function fetchTx (session) {
  var sql = 'SELECT * FROM transactions ' +
    'WHERE device_fingerprint=$1 AND session_id=$2 ' +
    'AND stage=$3 AND authority=$4 and incoming=$5'

  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)
      var values = [session.fingerprint, session.id, 'initial_request', 'pending', true]
      query(client, sql, values, function (err, results) {
        done()
        if (err) return reject(err)
        resolve(normalizeTxs(results.rows)[0])
      })
    })
  })
}

exports.addDispenseRequest = function addDispenseRequest (session, tx) {
  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)

      const originalSession = {id: tx.sessionId, fingerprint: session.fingerprint}
      async.waterfall([
        async.apply(updateDispense, client, originalSession, true),
        async.apply(insertIncoming, client, originalSession, tx, 0, tx.fiat,
          'dispense', 'pending')
      ], function (err) {
        done()

        if (err) return reject(err)
        resolve()
      })
    })
  })
}

function updateDispense (client, session, dispensed, cb) {
  var sql = 'UPDATE transactions SET dispensed=$1 ' +
    'WHERE stage=$2 AND authority=$3 AND device_fingerprint=$4 AND ' +
    'session_id=$5 AND incoming=$6'
  var values = [dispensed, 'initial_request', 'pending', session.fingerprint, session.id, true]
  query(client, sql, values, function (err, results) {
    if (err) return cb(err)
    if (results.rowCount === 0) return cb(new Error('No pending tx'))
    cb()
  })
}

exports.addDispense = function addDispense (session, tx, cartridges) {
  connect(function (cerr, client, done) {
    if (cerr) return

    async.waterfall([
      async.apply(insertIncoming, client, session, tx, 0, tx.fiat,
        'dispense', 'authorized'),
      async.apply(insertDispense, client, session, tx, cartridges)
    ], function (err) {
      done()
      if (err) logger.error(err)
    })
  })
}

exports.cartridgeCounts = function cartridgeCounts (session, cb) {
  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    var sql = 'SELECT id, count1, count2 FROM dispenses ' +
      'WHERE device_fingerprint=$1 AND refill=$2 ' +
      'ORDER BY id DESC LIMIT 1'
    query(client, sql, [session.fingerprint, true], function (err, results) {
      done()
      if (err) return cb(err)
      var counts = results.rows.length === 1
        ? [results.rows[0].count1, results.rows[0].count2]
        : [0, 0]
      cb(null, {id: results.rows[0].id, counts: counts})
    })
  })
}

exports.machineEvent = function machineEvent (rec, cb) {
  var TTL = 2 * 60 * 60 * 1000
  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    var fields = ['id', 'device_fingerprint', 'event_type', 'note', 'device_time']
    var sql = getInsertQuery('machine_events', fields, false)
    var values = [rec.id, rec.fingerprint, rec.eventType, rec.note, rec.deviceTime]

    var deleteSql = 'DELETE FROM machine_events WHERE (EXTRACT(EPOCH FROM (now() - created))) * 1000 > $1'
    var deleteValues = [TTL]

    query(client, deleteSql, deleteValues, function (err) {
      if (err) console.error(err)
    })

    query(client, sql, values, function (err, results) {
      done()
      return cb(err, results)
    })
  })
}

exports.devices = function devices (cb) {
  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    var sql = 'SELECT fingerprint, name FROM devices ' +
      'WHERE authorized=$1'
    query(client, sql, [true], function (err, results) {
      done()
      if (err) return cb(err)
      cb(null, results)
    })
  })
}

exports.machineEvents = function machineEvents (cb) {
  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)
    var sql = 'SELECT *, (EXTRACT(EPOCH FROM (now() - created))) * 1000 AS age FROM machine_events'
    query(client, sql, [], function (err, results) {
      done()
      if (err) return cb(err)
      cb(null, results)
    })
  })
}

function singleQuotify (item) { return '\'' + item + '\'' }

exports.fetchOpenTxs = function fetchOpenTxs (statuses, age, cb) {
  var _statuses = '(' + statuses.map(singleQuotify).join(',') + ')'

  var sql = 'SELECT * ' +
  'FROM transactions ' +
  'WHERE incoming=$1 AND ((EXTRACT(EPOCH FROM (now() - created))) * 1000)<$2 ' +
  'AND stage=$3 AND authority=$4 ' +
  'AND status IN ' + _statuses

  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)

    query(client, sql, [true, age, 'initial_request', 'pending'], function (err, results) {
      done()
      if (err) return cb(err)
      cb(null, normalizeTxs(results.rows))
    })
  })
}

exports.fetchUnnotifiedTxs = function fetchUnnotifiedTxs (age, waitPeriod, cb) {
  var sql = 'SELECT * ' +
  'FROM transactions ' +
  'WHERE incoming=$1 AND ' +
  '((EXTRACT(EPOCH FROM (now() - created))) * 1000)<$2 ' +
  'AND stage=$3 AND authority=$4 AND notified=$5 AND dispensed=$6 ' +
  'AND phone IS NOT NULL ' +
  "AND status IN ('instant', 'confirmed') " +
  'AND (redeem=$7 OR ((EXTRACT(EPOCH FROM (now() - created))) * 1000)>$8)'

  connect(function (cerr, client, done) {
    if (cerr) return cb(cerr)

    var values = [true, age, 'initial_request', 'pending', false, false, true, waitPeriod]
    query(client, sql, values, function (err, results) {
      done()
      if (err) return cb(err)
      cb(null, normalizeTxs(results.rows))
    })
  })
}

function pquery (sql, values) {
  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)
      query(client, sql, values, function (err, results) {
        done(err)
        if (err) return reject(err)
        resolve(results)
      })
    })
  })
}

exports.updateTxStatus = function updateTxStatus (tx, status, confirm) {
  var sql = confirm
  ? 'UPDATE transactions SET status=$1, confirmation_time=now() WHERE id=$2'
  : 'UPDATE transactions SET status=$1 WHERE id=$2'

  var values = [status, tx.id]

  return pquery(sql, values)
}

exports.updateRedeem = function updateRedeem (session, cb) {
  var sql = 'UPDATE transactions SET redeem=$1 ' +
  'WHERE incoming=$2 AND device_fingerprint=$3 AND session_id=$4 ' +
  'AND stage=$5 AND authority=$6'

  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)
      var values = [true, true, session.fingerprint, session.id, 'initial_request', 'pending']
      query(client, sql, values, function (err) {
        done(err)
        if (err) return reject(err)
        resolve()
      })
    })
  })
}

exports.updateNotify = function updateNotify (tx) {
  var sql = 'UPDATE transactions SET notified=$1 ' +
  'WHERE id=$2'

  return new Promise((resolve, reject) => {
    connect(function (cerr, client, done) {
      if (cerr) return reject(cerr)
      var values = [true, tx.id]
      query(client, sql, values, function (err) {
        done(err)
        if (err) return reject(err)
        resolve()
      })
    })
  })
}

function insertCachedRequest (session, path, method, body) {
  const fields = [
    'device_fingerprint',
    'session_id',
    'path',
    'method',
    'body'
  ]

  const sql = getInsertQuery('cached_responses', fields)
  return pquery(sql, [session.fingerprint, session.id, path, method, body])
}

exports.cachedResponse = function (session, path, method) {
  const sql = `select body from cached_responses
  where device_fingerprint=$1
  and session_id=$2
  and path=$3
  and method=$4`

  const values = [session.fingerprint, session.id, path, method]

  return insertCachedRequest(session, path, method, {pendingRequest: true})
  .then(() => ({}))
  .catch(err => {
    if (!isUniqueViolation(err)) throw err
    return pquery(sql, values)
    .then(r => ({body: r.rows[0].body}))
  })
}

function pruneCachedResponses () {
  const sql = `delete from cached_responses
  where (EXTRACT(EPOCH FROM (now() - created))) * 1000 < $1`

  const values = [CACHED_SESSION_TTL]

  return pquery(sql, values)
}

exports.cacheResponse = function (session, path, method, body) {
  const sql = `update cached_responses
  set body=$1
  where device_fingerprint=$2
  and session_id=$3
  and path=$4
  and method=$5`

  const values = [body, session.fingerprint, session.id, path, method]

  return pquery(sql, values)
}

/*
exports.init('postgres://lamassu:lamassu@localhost/lamassu')
connect(function(err, client, done) {
  var sql = 'select * from transactions where id=$1'
  query(client, sql, [130], function(_err, results) {
    done()
    console.dir(results.rows[0])
  })
})
*/
