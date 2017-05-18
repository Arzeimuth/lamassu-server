const _ = require('lodash/fp')

const db = require('./db')
const configManager = require('./config-manager')
const logger = require('./logger')
const schema = require('../lamassu-schema.json')

function allScopes (cryptoScopes, machineScopes) {
  const scopes = []
  cryptoScopes.forEach(c => {
    machineScopes.forEach(m => scopes.push([c, m]))
  })

  return scopes
}

function allCryptoScopes (cryptos, cryptoScope) {
  const cryptoScopes = []

  if (cryptoScope === 'global' || cryptoScope === 'both') cryptoScopes.push('global')
  if (cryptoScope === 'specific' || cryptoScope === 'both') cryptos.forEach(r => cryptoScopes.push(r))

  return cryptoScopes
}

function allMachineScopes (machineList, machineScope) {
  const machineScopes = []

  if (machineScope === 'global' || machineScope === 'both') machineScopes.push('global')
  if (machineScope === 'specific' || machineScope === 'both') machineList.forEach(r => machineScopes.push(r))

  return machineScopes
}

function satisfiesRequire (config, cryptos, machineList, field, refFields) {
  const fieldCode = field.code

  const scopes = allScopes(
    allCryptoScopes(cryptos, field.cryptoScope),
    allMachineScopes(machineList, field.machineScope)
  )

  return scopes.every(scope => {
    const isEnabled = () => refFields.some(refField => {
      return isScopeEnabled(config, cryptos, machineList, refField, scope)
    })

    const isBlank = _.isNil(configManager.scopedValue(scope[0], scope[1], fieldCode, config))
    const isRequired = refFields.length === 0 || isEnabled()

    const isValid = isRequired ? !isBlank : true

    return isValid
  })
}

function isScopeEnabled (config, cryptos, machineList, refField, scope) {
  const [cryptoScope, machineScope] = scope
  const candidateCryptoScopes = cryptoScope === 'global'
  ? allCryptoScopes(cryptos, refField.cryptoScope)
  : [cryptoScope]

  const candidateMachineScopes = machineScope === 'global'
  ? allMachineScopes(machineList, refField.machineScope)
  : [ machineScope ]

  const allRefCandidateScopes = allScopes(candidateCryptoScopes, candidateMachineScopes)
  const getFallbackValue = scope => configManager.scopedValue(scope[0], scope[1], refField.code, config)
  const values = allRefCandidateScopes.map(getFallbackValue)

  return values.some(r => r)
}

function getCryptos (config, machineList) {
  const scopes = allScopes(['global'], allMachineScopes(machineList, 'both'))
  const scoped = scope => configManager.scopedValue(scope[0], scope[1], 'cryptoCurrencies', config)
  return scopes.reduce((acc, scope) => _.union(acc, scoped(scope)), [])
}

function getGroup (fieldCode) {
  return _.find(group => _.includes(fieldCode, group.fields), schema.groups)
}

function getField (fieldCode) {
  const group = getGroup(fieldCode)
  return getGroupField(group, fieldCode)
}

function getGroupField (group, fieldCode) {
  const field = _.find(_.matchesProperty('code', fieldCode), schema.fields)
  return _.merge(_.pick(['cryptoScope', 'machineScope'], group), field)
}

// Note: We can't use machine-loader because it relies on settings-loader,
// which relies on this
function getMachines () {
  return db.any('select device_id from devices')
}

function fetchMachines () {
  return getMachines()
  .then(machineList => machineList.map(r => r.device_id))
}

function validateFieldParameter (value, validator) {
  switch (validator.code) {
    case 'required':
      return true   // We don't validate this here
    case 'min':
      return value >= validator.min
    case 'max':
      return value <= validator.max
    default:
      throw new Error('Unknown validation type: ' + validator.code)
  }
}

function ensureConstraints (config) {
  const pickField = fieldCode => schema.fields.find(r => r.code === fieldCode)

  return Promise.resolve()
  .then(() => {
    config.every(fieldInstance => {
      const fieldCode = fieldInstance.fieldLocator.code
      const field = pickField(fieldCode)
      if (!field) {
        logger.error('No such field: %s, %j', fieldCode, fieldInstance.fieldLocator.fieldScope)
        throw new Error('No such field: ' + fieldCode)
      }

      const fieldValue = fieldInstance.fieldValue

      const isValid = field.fieldValidation
      .every(validator => validateFieldParameter(fieldValue.value, validator))

      if (isValid) return true
      throw new Error('Invalid config value')
    })
  })
}

function validateRequires (config) {
  return fetchMachines()
  .then(machineList => {
    const cryptos = getCryptos(config, machineList)

    return schema.groups.filter(group => {
      return group.fields.some(fieldCode => {
        const field = getGroupField(group, fieldCode)
        if (!field.fieldValidation.find(r => r.code === 'required')) return false

        const refFields = _.map(_.partial(getField, group), field.enabledIf)

        return !satisfiesRequire(config, cryptos, machineList, field, refFields)
      })
    })
  })
  .then(arr => arr.map(r => r.code))
}

function validate (config) {
  return Promise.resolve()
  .then(() => ensureConstraints(config))
  .then(() => validateRequires(config))
  .then(arr => {
    if (arr.length === 0) return config
    throw new Error('Invalid configuration:' + arr)
  })
}

module.exports = {validate, ensureConstraints, validateRequires}
