var fs = require('fs'),
  // eslint-disable-next-line no-unused-vars
  colors = require('colors')

module.exports = function (program, conf) {

  function displayStrategyDetails(strategy, conf, cmdObj) {
    let strat = require(`../extensions/strategies/${strategy}/strategy`)
    console.log(strat.name.cyan + (strat.name === conf.strategy ? ' (default)'.grey : ''))
    if (strat.description) {
      console.log('  description:'.grey)
      console.log('    ' + strat.description.grey)
    }
    if (cmdObj.opt) {
      console.log('  options:'.grey)
      var ctx = {
        option: function (name, desc, type, def) {
          console.log(('    --' + name).green + '=<value>'.grey + '  ' + desc.grey + (typeof def !== 'undefined' ? (' (default: '.grey + def + ')'.grey) : ''))
        }
      }
      strat.getOptions.call(ctx, strat)
    }
    console.log()
  }
  
  program
    .command('list-strategies')
    .option('-s, --strategy <name>', 'Display single strategy')
    .option('-no, --no-opt', 'List without the options')
    .description('list available strategies')
    .action((cmdObj) => {
      if (cmdObj.strategy !== undefined) {
        displayStrategyDetails(cmdObj.strategy, conf, cmdObj)
      } else {
        var strategies = fs.readdirSync('./extensions/strategies')
        strategies.forEach((strategy) => {
          displayStrategyDetails(strategy, conf, cmdObj)
        })
      }
      process.exit()
    })
}

