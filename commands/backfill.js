var tb = require('timebucket')
  , crypto = require('crypto')
  , objectifySelector = require('../lib/objectify-selector')
  , collectionService = require('../lib/services/collection-service')

module.exports = function (program, conf) {
  program
    .command('backfill [selector]')
    .description('download historical trades for analysis')
    .option('--conf <path>', 'path to optional conf overrides file')
    .option('--debug', 'output detailed debug info')
    .option('-d, --days <days>', 'number of days to acquire (default: ' + conf.days + ')', Number, conf.days)
    .option('--start <unix_in_ms>', 'lower bound as unix time in ms', Number, -1)
    .option('--end <unix_in_ms>', 'upper bound as unix time in ms', Number, -1)
    .action(function (selector, cmd) {

      // Convert selector string (like: binance.ADA-USDT) to an object
      // {exchange_id: [exchange identifier], product_id: [pair symbol], asset: [asset], currency: [currency], normalized: [full text]}
      selector = objectifySelector(selector || conf.selector)

      // Load exchange module
      var exchange = require(`../extensions/exchanges/${selector.exchange_id}/exchange`)(conf)
      if (!exchange) {
        console.error('cannot backfill ' + selector.normalized + ': exchange not implemented')
        process.exit(1)
      }

      // Initialize MongoDB Collection Service 
      var collectionServiceInstance = collectionService(conf)
      var tradesDb = collectionServiceInstance.getTrades()
      var resumeMarkersDb = collectionServiceInstance.getResumeMarkers()

      // Create "resume_markers" collection record structure
      var marker = {
        id: crypto.randomBytes(4).toString('hex'),
        selector: selector.normalized,
        from: null,
        to: null,
        oldest_time: null,
        newest_time: null
      }

      marker._id = marker.id
      var trade_counter = 0
      var day_trade_counter = 0
      var get_trade_retry_count = 0
      var get_trade_retry_later = 0
      var days_left = cmd.days + 1
      var target_time, start_time
      var mode = exchange.historyScan
      var last_batch_id, last_batch_opts
      var offset = exchange.offset
      var markers, trades

      // Check history backfill echange support       
      if (!mode) {
        console.error('cannot backfill ' + selector.normalized + ': exchange does not offer historical data')
        process.exit(0)
      }

      // Initialize start_time and target_time time stamps, according to -d, --days <days> or --start <unix_in_ms>, --end <unix_in_ms> arguments
      if (mode === 'backward') {
        target_time = new Date().getTime() - (86400000 * cmd.days)
      }
      // mode === 'forward'
      else {
        if(cmd.start >= 0 && cmd.end >= 0){
          start_time = cmd.start
          target_time = cmd.end
        } else {
          target_time = new Date().getTime()
          start_time = new Date().getTime() - (86400000 * cmd.days)
        }
      }
      
      // Retrieve all "resume_markers" records for given selector (like: binance.ADA-USDT) and sort it
      resumeMarkersDb.find({selector: selector.normalized}).toArray(function (err, results) {
        if (err) throw err
        markers = results.sort(function (a, b) {
          if (mode === 'backward') {
            if (a.to > b.to) return -1
            if (a.to < b.to) return 1
          }
          // mode === 'forward'
          else {
            if (a.from < b.from) return -1
            if (a.from > b.from) return 1
          }
          return 0
        })
        getNext()
      })

      function getNext () {
        var opts = {product_id: selector.product_id}
        if (mode === 'backward') {
          opts.to = marker.from
        }
        // mode === 'forward'
        else {
          if (marker.to) opts.from = marker.to + 1
          else opts.from = exchange.getCursor(start_time)
        }
        if (offset) {
          opts.offset = offset
        }
        last_batch_opts = opts
        exchange.getTrades(opts, function (err, results) {
          trades = results
          if (err) {
            console.error('err backfilling selector: ' + selector.normalized)
            console.error(err)
            if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
              console.error('retrying...')
              setImmediate(getNext)
              return
            }
            console.error('aborting!')
            process.exit(1)
          }
          if (mode !== 'backward' && !trades.length) {
            // Finish trades backfill if: 
            // 1. overall trade_counter > 0
            // 2. last backfill attempt time (opts.from) has reached target_time and is behind it
            // 3. unless target_time is in the future 
            if (trade_counter && (target_time <= opts.from || target_time > new Date().getTime())) {
              console.log('\ndownload complete!\n')
              process.exit(0)
            }
            else {
              // Reattempt for two hours, every 10 seconds
              if (get_trade_retry_count < 720) {
                const delay = tb('s', 10).resize('ms').value

                get_trade_retry_count++
                get_trade_retry_later += delay;
                // Move next start_time one second later
                marker.to += delay
                //start_time += (target_time - start_time)*0.4

                console.error('Attempt:', tb('ms', get_trade_retry_later).resize('1m').value, 'minutes later, getTrades() returned no trades from', opts.from, ', retrying ten second later from', marker.to)
                setImmediate(getNext)
                return
              }
              else {
                console.error('\ngetTrades() returned no trades, --start may be too remotely in the past.')
                process.exit(1)
              }
            }
          }
          else if (!trades.length) {
            console.log('\ngetTrades() returned no trades, we may have exhausted the historical data range.')
            process.exit(0)
          }
          trades.sort(function (a, b) {
            if (mode === 'backward') {
              if (a.time > b.time) return -1
              if (a.time < b.time) return 1
            }
            else {
              if (a.time < b.time) return -1
              if (a.time > b.time) return 1
            }
            return 0
          })
          if (last_batch_id && last_batch_id === trades[0].trade_id) {
            console.error('\nerror: getTrades() returned duplicate results')
            console.error(opts)
            console.error(last_batch_opts)
            process.exit(0)
          }
          last_batch_id = trades[0].trade_id
          runTasks(trades)
        })
      }

      function runTasks (trades) {
        Promise.all(trades.map((trade)=>saveTrade(trade))).then(function(/*results*/){
          var oldest_time = marker.oldest_time
          var newest_time = marker.newest_time
          markers.forEach(function (other_marker) {
            // for backward scan, if the oldest_time is within another marker's range, skip to the other marker's start point.
            // for forward scan, if the newest_time is within another marker's range, skip to the other marker's end point.
            if (mode === 'backward' && marker.id !== other_marker.id && marker.from <= other_marker.to && marker.from > other_marker.from) {
              marker.from = other_marker.from
              marker.oldest_time = other_marker.oldest_time
            }
            else if (mode !== 'backward' && marker.id !== other_marker.id && marker.to >= other_marker.from && marker.to < other_marker.to) {
              marker.to = other_marker.to
              marker.newest_time = other_marker.newest_time
            }
          })
          var diff
          if (oldest_time !== marker.oldest_time) {
            diff = tb(oldest_time - marker.oldest_time).resize('1h').value
            console.log('\nskipping ' + diff + ' hrs of previously collected data')
          }
          else if (newest_time !== marker.newest_time) {
            diff = tb(marker.newest_time - newest_time).resize('1h').value
            console.log('\nskipping ' + diff + ' hrs of previously collected data')
          }
          resumeMarkersDb.replaceOne({_id: marker.id}, marker, {upsert: true})
            .then(setupNext)
            .catch(function(err){
              if (err) throw err
            })
        }).catch(function(err){
          if (err) {
            console.error(err)
            console.error('retrying...')
            return setTimeout(runTasks, 10000, trades)
          }
        })
      }

      function setupNext() {
        trade_counter += trades.length
        day_trade_counter += trades.length
        var current_days_left = 1 + (mode === 'backward' ? tb(marker.oldest_time - target_time).resize('1d').value : tb(target_time - marker.newest_time).resize('1d').value)
        if (current_days_left >= 0 && current_days_left != days_left) {
          console.log('\n' + selector.normalized, 'saved', day_trade_counter, 'trades', current_days_left, 'days left')
          day_trade_counter = 0
          days_left = current_days_left
        } else {
          process.stdout.write('.')
        }

        if (mode === 'backward' && marker.oldest_time <= target_time) {
          console.log('\ndownload complete!\n')
          process.exit(0)
        } else if(cmd.start >= 0 && cmd.end >= 0 && target_time <= marker.newest_time){
          console.log('\ndownload of span ('+cmd.start+' - '+cmd.end+') complete!\n')
          process.exit(0)
        }

        if (exchange.backfillRateLimit) {
          setTimeout(getNext, exchange.backfillRateLimit)
        } else {
          setImmediate(getNext)
        }
      }

      function saveTrade (trade) {
        trade.id = selector.normalized + '-' + String(trade.trade_id)
        trade._id = trade.id
        trade.selector = selector.normalized
        var cursor = exchange.getCursor(trade)
        if (mode === 'backward') {
          if (!marker.to) {
            marker.to = cursor
            marker.oldest_time = trade.time
            marker.newest_time = trade.time
          }
          marker.from = marker.from ? Math.min(marker.from, cursor) : cursor
          marker.oldest_time = Math.min(marker.oldest_time, trade.time)
        }
        else {
          if (!marker.from) {
            marker.from = cursor
            marker.oldest_time = trade.time
            marker.newest_time = trade.time
          }
          marker.to = marker.to ? Math.max(marker.to, cursor) : cursor
          marker.newest_time = Math.max(marker.newest_time, trade.time)
        }
        return tradesDb.replaceOne({_id: trade.id}, trade, {upsert: true})
      }
    })
}
