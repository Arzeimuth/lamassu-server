const coinUtils = require('../coin-utils')

const common = require('./common')

module.exports = {setup}

function setup (dataDir) {
  const coinRec = coinUtils.getCryptoCurrency('ETH')
  common.firewall([coinRec.defaultPort])
  const cmd = `/usr/local/bin/${coinRec.daemon} --datadir "${dataDir}" --mode active --warp --pruning fast --db-compaction ssd --cache-size 2048 --max-peers 40`
  common.writeSupervisorConfig(coinRec, cmd)
}
