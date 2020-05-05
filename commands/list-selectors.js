// eslint-disable-next-line no-unused-vars
var colors = require('colors'),
  fs = require('fs')

module.exports = function (program) {

  function printExchangeDetails(exchange, asset) {
    var allPproducts = require(`../extensions/exchanges/${exchange}/products.json`)
    let products = asset !== undefined ? allPproducts.filter((pair) => { return pair.asset === asset; }) : allPproducts;
    if (products.length) {
      products.sort(function (a, b) {
        if (a.asset < b.asset) return -1
        if (a.asset > b.asset) return 1
        if (a.currency < b.currency) return -1
        if (a.currency > b.currency) return 1
        return 0
      })
  
      console.log(`${exchange}:`)
      products.forEach(function (p) {
        console.log('  ' + exchange.cyan + '.'.grey + p.asset.green + '-'.grey + p.currency.cyan + (p.label ? ('   (' + p.label + ')').grey : ''))
      })
    }
  }
  
  program
    .command('list-selectors')
    .option('-e, --exchange <exchange>', 'Select single exchange')
    .option('-a, --asset <asset>', 'Select single asset')
    .description('list available selectors')
    .action((cmdObj) => {
      if (cmdObj.exchange !== undefined) {
        printExchangeDetails(cmdObj.exchange, cmdObj.asset)
      } else {
        var exchanges = fs.readdirSync('./extensions/exchanges')
        exchanges.forEach(function(exchange){
          if (exchange === 'sim' || exchange === '_stub') return
          printExchangeDetails(exchange, cmdObj.asset)
        })
      }
      process.exit()
    })
}

