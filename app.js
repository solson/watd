'use strict';

var config     = require('./config'),
    express    = require('express'),
    app        = express(),
    fs         = require('fs'),
    http       = require('http').Server(app),
    io         = require('socket.io')(http),
    moment     = require('moment'),
    path       = require('path'),
    tinyliquid = require('tinyliquid');

var GitHubApi = require('github');
var github = new GitHubApi({version: '3.0.0'});

var LastFmNode = require('lastfm').LastFmNode;
var lastfm = new LastFmNode({
  api_key: config.lastfmApiKey,
  secret: config.lastfmApiSecret
});

var Steam = require('steam-webapi');
Steam.key = config.steamApiKey;
var STEAM_STATES = [
  'Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade',
  'Looking to play'
];
var STEAM_STATE_FLAGS = {
  512: 'Mobile',
  1024: 'Big Picture Mode'
}

/*
 * Parse the tinyliquid templates in the templates directory into an object of
 * rendering functions. Given a file 'templates/foo.html' we will have the
 * rendering function 'TEMPLATES.foo(locals, callback)'.
 */
function parseTemplates(templateDir) {
  var templates = {};
  fs.readdirSync(templateDir).forEach(function(file) {
    if (/\.html$/.test(file)) {
      var name = file.slice(0, file.length - 5);
      var source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      var renderFn = tinyliquid.compile(source);
      templates[name] = function(locals, callback) {
        var context = tinyliquid.newContext({locals: locals});
        return renderFn(context, function(err) {
          if (err) {
            callback(err, null);
          } else {
            callback(null, context.getBuffer());
          }
        });
      };
    }
  });
  return templates;
}
var TEMPLATE_DIR = path.join(__dirname, 'templates');
var TEMPLATES = parseTemplates(TEMPLATE_DIR);

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
  console.log('error in ' + source + ':', err.stack ? err.stack : err);
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
        TEMPLATES[service.name](data, function(err, html) {
          if (err) {
            logError('sendUpdate for ' + service.name, err);
            return;
          }
          if (service.cachedHtml === html) { return; }
          // Here we cache the most recently generated HTML into the
          // config.users structure which is interpolated into the index.html
          // template, so when a new client loads the page the most
          // recent data will be loaded with it.
          service.cachedHtml = html;
          io.emit('update', {
            name: user.name, service: service.name, html: html
          });
        });
      }

      if (service.name === 'lastfm') {
        initLastfmWatcher(service.username, sendUpdate);
      } else if (service.name === 'steam') {
        // TODO: batch the steam requests into one request, since the steam API
        // supports it
        initSteamWatcher(service.username, sendUpdate);
      } else if (service.name === 'github') {
        initGithubWatcher(service.username, sendUpdate);
      } else {
        throw new Error('unsupported service: ' + service.name);
      }
    });
  });
}

function initGithubWatcher(username, sendUpdate) {
  repeat(config.requestIntervals.github, function(done) {
    github.authenticate({type: 'oauth', token: config.githubAccessToken});
    github.events.getFromUserPublic({user: username}, function(err, events) {
      if (err) {
        logError('github.events.getFromUserPublic', err);
        return done();
      }

      var latestEvent = events[0];
      sendUpdate({
        avatar: latestEvent.actor.avatar_url,
        user: username,
        eventType: latestEvent.type,
        timeAgo: moment(latestEvent.created_at, moment.ISO_8601).fromNow(),
        repo: latestEvent.repo.name,
        event: latestEvent.payload
      });
      done();
    });
  });
}

function initLastfmWatcher(username, sendUpdate) {
  repeat(config.requestIntervals.lastfm, function(done) {
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
        logError('lastfm/user.getrecenttracks',
                 new Error('unexpected response'));
        done();
        return;
      }

      var track = data.recenttracks.track;
      if (track instanceof Array) {
        track = track[0];
      }

      var nowPlaying = !!(track['@attr'] && track['@attr']['nowplaying']);

      var data = {
        username: username,
        artist: track.artist['#text'],
        album: track.album['#text'],
        track: track.name,
        url: track.url,
        nowplaying: nowPlaying
      };

      if (track.date && track.date.uts) {
        data.timeago = moment.unix(track.date.uts).fromNow();
      }

      if (track.image instanceof Array) {
        var small_image = track.image.filter(function(image) {
          return image.size === 'small';
        })[0];
        if (small_image) { data.image = small_image['#text']; }
      }

      sendUpdate(data);
      done();
    });
  });
}

function initSteamWatcher(username, sendUpdate) {
  var steam = new Steam();
  repeat(config.requestIntervals.steam, function(done) {
    steam.getPlayerSummaries({steamids: username}, function(err, data) {
      if (err) {
        logError('steam.getPlayerSummaries', err);
      } else if (!data.players || !(data.players instanceof Array) ||
                 !data.players[0]) {
        logError('steam.getPlayerSummaries', new Error('unexpected response'));
      } else {
        var player = data.players[0];
        var data = {
          username: player.personaname,
          profileUrl: player.profileurl,
          avatar: player.avatar
        };

        if (player.gameextrainfo) {
          data.state = 'Playing ' + player.gameextrainfo;
        } else {
          data.state = STEAM_STATES[player.personastate];
        }

        if (player.personastate === 0 && player.lastlogoff) {
          data.lastlogoff = moment.unix(player.lastlogoff).fromNow();
        }

        var stateFlag = STEAM_STATE_FLAGS[player.personastateflags];
        if (stateFlag) {
          data.state += ' (' + stateFlag + ')';
        }

        sendUpdate(data);
      }
      done();
    });
  });
}

Steam.ready(function(err) {
  if (err) {
    logError('Steam.ready', err);
    process.exit(1);
  }
  initWatchers();
});

app.use(express.static(__dirname + '/public'));

app.get('/', function(req, res) {
  if (process.env.NODE_ENV !== 'production') {
    TEMPLATES = parseTemplates(TEMPLATE_DIR);
  }
  var locals = {users: config.users, title: config.title};
  TEMPLATES.index(locals, function(err, html) {
    if (err) { return logError('rendering index.html', err); }
    res.send(html);
  });
});

http.listen(config.port, function() {
  console.log('Listening on http://localhost:' + config.port);
});
