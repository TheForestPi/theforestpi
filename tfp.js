/*
https://www.internet-radio.com/stations/smooth%20jazz/#

[Smooth Jazz Florida]
http://us4.internet-radio.com:8266/listen.pls
*/
const fs = require('fs');
const util = require('util');
const path = require('path');
const moment = require('moment');
const Log = require('./log');
Log.log_flag |= Log.info;
Log.log_flag |= Log.error;
Log.log_flag |= Log.debug;
var Config = require('./config.json');

const SYNC_ALL_IN_MS = (30 * 1000);
const DROPBOX_APPNAME = 'TheForestPi';
const APP_DIR = __dirname + '/' + DROPBOX_APPNAME;
const CONFIG_DIR = __dirname + '/' + DROPBOX_APPNAME + '/config';
const SONGS_DIR = __dirname + '/' + DROPBOX_APPNAME + '/songs';
const PLAYLIST_DIR = __dirname + '/' + DROPBOX_APPNAME + '/playlist';
const PLAYING_LOG_FILENAME = __dirname + '/playing.log';
const DBX_PLAYING_LOG_PATH = '/playing.log';
const DBX_PLAYING_LOG_MAX_LINE_COUNT = 1000;

var temp_playlist_fn = '/tmp/tfp.m3u';
var mpg123_player = null;
var check_timer = null;

const fetch = require('isomorphic-fetch');
const Dropbox = require('dropbox').Dropbox;
const dbx = new Dropbox({
	fetch: fetch,
	accessToken: Config.ACCESS_TOKEN
});

function get_tickcnt() {
	return moment().format('x');
}

function is_tickcnt_elapsed(tickcnt, ms) {
	return (get_tickcnt() - tickcnt) >= ms;
}

function readFilePromise(filename) {
	return new Promise(function(resolve, reject) {
		fs.readFile(filename, (err, data) => {
			if (!err) {
				resolve(data);
			} else {
				reject(err);
			}
		});
	});
}

// check and create directory
[APP_DIR, CONFIG_DIR, PLAYLIST_DIR, SONGS_DIR].forEach(dir => {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir);
	}
});

// schedule timer
schedule_timer = setInterval(function() {
	var schedule_fn = CONFIG_DIR + '/schedule.json';
	if (!fs.existsSync(schedule_fn)) {
		return;
	}

	readFilePromise(schedule_fn)
		.then((content) => {
			var schedule = JSON.parse(content);
			if (schedule.enabled) {
				var curr_tm = new Date();
				for (var i in schedule.list) {
					var item = schedule.list[i];
					var from_tm = new Date(curr_tm);
					var to_tm = new Date(curr_tm);
					try {
						var fromlst = item.from.split(':');
						if (fromlst.length == 2) {
							var tolst = item.to.split(':');
							if (tolst.length == 2) {
								from_tm.setHours(parseInt(fromlst[0]));
								from_tm.setMinutes(parseInt(fromlst[1]));
								to_tm.setHours(parseInt(tolst[0]));
								to_tm.setMinutes(parseInt(tolst[1]));

								var curr_ts = curr_tm.getTime();
								var from_ts = from_tm.getTime();
								var to_ts = to_tm.getTime();
								var match_flag = false;
								if (!item.invert) {
									if ((curr_ts >= from_ts) && (curr_ts <= to_ts)) {
										match_flag = true;
									}
								} else {
									if (!((curr_ts >= from_ts) && (curr_ts <= to_ts))) {
										match_flag = true;
									}
								}

								if (match_flag) {
									if (item.command == 'play') {
										var curr_pl = getCurrentPlaylist();
										// check if already playing requested playlist
										if (curr_pl != item.option) {
											play(item.option);
										}
									} else
									if (item.command == 'stop') {
										var curr_pl = getCurrentPlaylist();
										if (curr_pl != '') {
											stopCurrentPlaylist();
											playing_log('Playlist \"' + curr_pl + '\" finished.');
										}
									}
								}
							}
						}
					} catch (e) {
						Log.e(e);
					}
				}
			} else {
				//console.log('config.schedule.disabled');
			}
		})
		.catch((err) => {
			Log.e(err);
		})
}, 1000);

var sync_all_flag = false;
setInterval(function() {
	if (!sync_all_flag) {
		sync_all_flag = true;
		(async function symc_all() {
			const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
			var folders = [{
				path: '/songs',
				files: []
			}, {
				path: '/playlist',
				files: []
			}, {
				path: '/config',
				files: []
			}];

			Log.i('sync_all start...');

			// list all updated files
			for (let i = 0; i < folders.length; i++) {
				await dbx.filesListFolder({
						path: folders[i].path
					})
					.then((response) => {
						response.entries.forEach((item) => {
							var fn = APP_DIR + item.path_display;
							if (fs.existsSync(fn)) {
								// check file is upto date
								var stat = fs.statSync(fn);
								var mtime_iso = new Date(stat.mtime).toISOString();
								mtime_iso = mtime_iso.substr(0, mtime_iso.length - 5) + mtime_iso.charAt(mtime_iso.length - 1);
								if (mtime_iso != item.client_modified) {
									folders[i].files.push({
										path: item.path_display,
										exists: true
									});
								} else {
									//console.log('existing file match, ' + fn);
								}
							} else {
								folders[i].files.push({
									path: item.path_display,
									exists: false
								});
							}
						});
					})
					.catch((err) => {
						//console.log(err);
					});
			}

			//console.log(util.inspect(folders, {maxArrayLength: null, depth:null }));

			for (let i = 0; i < folders.length; i++) {
				for (let j = 0; j < folders[i].files.length; j++) {
					var path = folders[i].files[j].path;
					if (folders[i].files[j].exists) {
						Log.i('update ' + path);
					} else {
						Log.i('download ' + path);
					}

					await dbx.filesDownload({
							path: path
						})
						.then((response) => {
							var fn = APP_DIR + response.path_display;
							if (fs.existsSync(fn)) {
								fs.unlinkSync(fn);
							}
							fs.writeFileSync(fn, response.fileBinary);
							// update file timestamp
							var ts = new Date(response.client_modified);
							fs.utimesSync(fn, ts, ts);
						})
						.catch((err) => {
							//
						});
				}
			}

			Log.i('sync_all finished');

			// sleep some
			await delay(SYNC_ALL_IN_MS);
			sync_all_flag = false;
		})();
	}
}, 1000);

function playing_log(line) {
	var buf = new Buffer.from(moment().format('YYYY-MM-DD HH:mm:ss') + '\t' + line + '\r\n', 'utf8');;
	var new_buf = new Buffer.from(buf);
	try {
		var playing_log = fs.readFileSync(PLAYING_LOG_FILENAME);
		var pllst = playing_log.toString().split('\r\n');
		var str = '';
		var indx = 0;
		if (pllst.length >= DBX_PLAYING_LOG_MAX_LINE_COUNT) {
			indx = pllst.length - DBX_PLAYING_LOG_MAX_LINE_COUNT;
		}
		for (var i = indx; i < pllst.length; i++) {
			if (pllst[i] != '') {
				str += pllst[i] + '\r\n';
			}
		}

		new_buf = new Buffer.concat([Buffer.from(str), buf]);
		fs.writeFileSync(PLAYING_LOG_FILENAME, new_buf);
	} catch (err) {
		// file not exist
		fs.writeFileSync(PLAYING_LOG_FILENAME, new_buf);
	}

	// upload to dropbox
	dbx.filesUpload({
			path: DBX_PLAYING_LOG_PATH,
			contents: new_buf,
			mode: 'overwrite'
		})
		.then(response => {
			//console.log(response);
		})
		.catch(err => {
			//console.log(err);
		});
}

function play(playlist) {
	// check if playlist found
	if (!(isFileExists(PLAYLIST_DIR + '/' + playlist))) {
		Log.e('playlist not found!');
	} else {
		// stop current playing
		stopCurrentPlaylist();
		// append current playlist name
		fs.appendFileSync(temp_playlist_fn, '#' + playlist + '\n', 'utf8');
		fs.readFileSync(PLAYLIST_DIR + '/' + playlist).toString().split('\n').forEach((line) => {
			// next append other
			if (line.length > 0) {
				line = line.trim();
				// check comment line
				if (line.charAt(0) != '#') {
					var http_str = line.substr(0, 7);
					if (http_str == 'http://') {
						fs.appendFileSync(temp_playlist_fn, line + '\n', 'utf8');
					} else {
						// detect linux path
						if (line.indexOf('/') != -1) {
							var strlst = line.split('/');
						} else {
							var strlst = line.split('\\');
						}
						fs.appendFileSync(temp_playlist_fn, SONGS_DIR + '/' + strlst[strlst.length - 1] + '\n', 'utf8');
					}
				} else {
					fs.appendFileSync(temp_playlist_fn, line + '\n', 'utf8');
				}
			}
		});

		// do play
		mpg123_player = new require('child_process').execFile('/usr/bin/mpg123', [
			'-@', temp_playlist_fn
		]);

		// mpg123 log output is stderr
		mpg123_player.stderr.on('data', (data) => {
			var strlst = data.toString().split('\n');
			strlst.forEach((line) => {
				var lnlst = line.toString().split(' ');
				if (lnlst.length > 0) {
					if (lnlst[0] == 'Playing') {
						Log.i(line);
						playing_log(line);
					}
				}
			});
		});

		// check for mpg123 terminate
		check_timer = setInterval(function() {
			if (mpg123_player != null) {
				if (mpg123_player.exitCode != null) {
					Log.i('mpg123 terminated!');
					if (check_timer != null) {
						clearInterval(check_timer);
					}
					check_timer = null;
					removeTempPlaylistFile();
				}
			}
		}, 1000);
	}
}

function removeTempPlaylistFile() {
	// remove file
	try {
		fs.unlinkSync(temp_playlist_fn);
	} catch (e) {
		//
	} finally {
		//
	}
}

function stopCurrentPlaylist() {
	var curr_pl = getCurrentPlaylist();

	if (mpg123_player != null) {
		if (mpg123_player.exitCode == null) {
			mpg123_player.kill('SIGTERM');

			mpg123_player = null;
		}
	}

	if (check_timer != null) {
		clearInterval(check_timer);
	}
	check_timer = null;

	// remove temp playlist file
	removeTempPlaylistFile();

	return curr_pl;
}

function getCurrentPlaylist() {
	var result = '';

	try {
		var pl_lst = fs.readFileSync(temp_playlist_fn).toString().split('\n');
		if (pl_lst.length > 0) {
			result = pl_lst[0].substr(1);
		}
	} catch (e) {
		// file not found
	} finally {
		//
	}

	return result;
}

function isFileExists(file_name) {
	try {
		// Query the entry
		stats = fs.lstatSync(file_name);
		return true;
	} catch (e) {
		return false;
	}
}

//so the program will not close instantly
process.stdin.resume();

function exitHandler(options, err) {
	// check and stop current playing
	stopCurrentPlaylist();

	if (options.cleanup) {
		//console.log('clean');
	}
	if (err) {
		//console.log(err.stack);
	}
	if (options.exit) {
		process.exit();
	}
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, {
	cleanup: true
}));
//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
	exit: true
}));
//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {
	exit: true
}));
