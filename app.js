'use strict';

var config = require('./config'),
    app    = require('express')(),
    http   = require('http').Server(app),
    io     = require('socket.io')(http),
    moment = require('moment'),
    mu     = require('mu2');

var LastFmNode = require('lastfm').LastFmNode;
var lastfm = new LastFmNode({
  api_key: config.lastfmApiKey,
  secret: config.lastfmApiSecret
});

var Steam = require('steam-webapi');
Steam.key = config.steamApiKey;

/**
 * Run the given function repeatedly. Wait the given length of time between each
 * call.
 * @param {number} interval Time in milliseconds
 * @param {function} f
 */
function repeat(interval, f) {
  f(function() {
    setTimeout(function() {
      repeat(interval, f);
    }, interval);
  });
}

/**
 * Print an error message including the source of the error.
 */
function logError(source, err) {
  console.log("error in " + source + ":", err);
}

/**
 * If err is not null, print an error message including the source of the error
 * and exit the process.
 */
function checkError(source, err) {
  if (err) {
    logError(source, err);
    console.log("bailing out early");
    process.exit(1);
  }
}

/**
 * Initialize the infinite loops which repeatedly check for new updates from the
 * various services we want to monitor.
 */
function initWatchers() {
  // TODO: detect when requests fail many times in a row so we can tell the
  // frontend that the current data is stale
  config.users.forEach(function(user) {
    user.services.forEach(function(service) {
      var sendUpdate = function(data) {
        var stream = mu.compileAndRender(service.service + '.html', data);
        var html = '';
        stream.on('data', function(chunk) { html += chunk; });
        stream.on('end', function() {
          if (service.cachedHtml == html) { return; }
          // Here we cache the most recently generated HTML into the
          // config.users structure which is interpolated into the index.html
          // template, so when a new client loads the page the most
          // recent data will be loaded with it.
          service.cachedHtml = html;
          io.emit('update', {
            name: user.name, service: service.service, html: html
          });
        });
      }

      if (service.service == 'lastfm') {
        initLastfmWatcher(service.username, sendUpdate);
      } else if (service.service == 'steam') {
        // TODO: batch the steam requests into one request, since the steam API
        // supports it
        initSteamWatcher(service.username, sendUpdate);
      }
    });
  });
}

function initLastfmWatcher(username, sendUpdate) {
  repeat(config.requestIntervalMs, function(done) {
    var request = lastfm.request('user.getrecenttracks', {
      user: username,
      limit: 1
    });
    request.on('error', function(err) {
      logError('lastfm/user.getrecenttracks', err);
      done();
    });
    request.on('success', function(data) {
      if (!data || !data.recenttracks || !data.recenttracks.track) {
        logError('lastfm/user.getrecenttracks', 'unexpected response');
        done();
        return;
      }

      var track = data.recenttracks.track;
      if (track instanceof Array) {
        track = track[0];
      }

      var nowPlaying = !!(track["@attr"] && track["@attr"]["nowplaying"]);

      var data = {
        username: username,
        artist: track.artist['#text'],
        album: track.album['#text'],
        track: track.name,
        url: track.url,
        nowPlaying: nowPlaying
      };

      if (track.date && track.date.uts) {
        data.timeAgo = moment.unix(track.date.uts).fromNow();
      }

      if (track.image instanceof Array) {
        for (var i = 0, len = track.image.length; i < len; ++i) {
          if (track.image[i].size == 'small') {
            data.image = track.image[i]['#text']
            break;
          }
        }
      }

      sendUpdate(data);
      done();
    });
  });
}

function initSteamWatcher(username, sendUpdate) {
  var steam = new Steam();
  repeat(config.requestIntervalMs, function(done) {
    steam.getPlayerSummaries({steamids: username}, function(err, data) {
      if (err) {
        logError('steam.getPlayerSummaries', err);
      } else if (!data.players || !(data.players instanceof Array) ||
                 !data.players[0]) {
        logError('steam.getPlayerSummaries', 'unexpected response');
      } else {
        var STATES = [
          'Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade',
          'Looking to play'
        ];

        var player = data.players[0];
        var data = {
          username: player.personaname,
          profileUrl: player.profileurl,
          avatar: player.avatar
        };

        if (player.gameextrainfo) {
          data.state = 'Playing ' + player.gameextrainfo;
        } else {
          data.state = STATES[player.personastate];
        }

        if (data.personastate == 0 && player.lastlogoff) {
          data.lastLogoff = moment.unix(player.lastlogoff).fromNow();
        }

        // TODO: Get rid of magic numbers
        if (player.personastateflags == 512) {
          data.state += ' (Mobile)';
        } else if (player.personastateflags == 1024) {
          data.state += ' (Big Picture mode)';
        }

        sendUpdate(data);
      }
      done();
    });
  });
}

Steam.ready(function(err) {
  checkError('Steam.ready', err);
  initWatchers();
});

app.get('/', function(req, res) {
  if (process.env.NODE_ENV == 'DEVELOPMENT') {
    mu.clearCache();
  }
  mu.compileAndRender('index.html', {
    users: config.users, title: config.title
  }).pipe(res);
});

http.listen(config.port, function() {
  console.log('Listening on http://localhost:3000');
});
