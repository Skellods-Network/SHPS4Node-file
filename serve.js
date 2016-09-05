'use strict';

var me = module.exports;

var async = require('vasync');
var crypto = require('crypto');
var q = require('q');
var fs = require('fs')
var oa = require('object-assign');
var stream = require('stream');
var util = require('util');
var defer = require('promise-defer');
var path = require('path');

var libs = require('node-mod-load').libs;


/**
 * Read data from DB
 * A fileObject contains all file information from the DB and can be extended (e.g. with bin-data)
 * An errorObject will contain a msg (string) and a HTTP-status (int)
 *
 * @param $requestState Object
 * @param $name string
 * @result Promise(fileObject or errorObject)
 */
var _getFileInfo = function f_file_serve_getFileInfo($requestState, $name, $cb) {

    libs.sql.newSQL('default', $requestState).done(function ($sql) {

        var tblMT = $sql.openTable('mimeType');
        var tblU = $sql.openTable('upload');
        $sql.query()
            .get([
                tblU.col('fileName'),
                tblU.col('cache'),
                tblU.col('ttc'),
                tblU.col('hash'),
                tblU.col('lastModified'),
                tblU.col('accessKey'),
                tblU.col('compressedSize'),
                tblU.col('size'),
                tblMT.col('name', 'mimeType')
            ])
            .fulfilling()
            .eq(tblU.col('mimeType'), tblMT.col('ID'))
            .eq(tblU.col('name'), $name)
            .execute()
            .done(function ($rows) {

                $sql.free();
                if ($rows.length <= 0) {

                    $cb({
                        msg: 'File not found',
                        status: 404,
                    });

                    return;
                }

                var fo = $rows[0];
                fo.requestState = $requestState;
                fo.name = $name;

                $cb(null, fo);
            }, function ($err) {

                $sql.free();
                var msg = 'Database Error';
                if (libs.main.isDebug()) {

                    msg += ': ' + $err;
                }

                $cb({
                    msg: msg,
                    status: 500,
                });
            });
    });
};

/**
 * Check if requestor has access to specified file
 *
 * @param $fileObject Object
 * @result Promise(fileObject or errorObject)
 */
var _hasAccessKey = function f_file_serve_hasAccessKey($fileObject, $cb) {

    $fileObject.requestState.cache.auth.hasAccessKeyExt($fileObject.accessKey).done(function ($result) {

        if ($result.hasAccessKey) {

            $cb(null, $fileObject);
        }
        else {

            $cb({
                msg: $result.message,
                status: $result.httpStatus,
            });
        }
    }, $cb);
};

var _getFileLocation = function f_file_serve_addFileData($fileObject, $cb) {

    var pathList = [
        libs.main.getDir(SHPS_DIR_POOL) + $fileObject.requestState.config.generalConfig.URL.value + path.sep + $fileObject.fileName,
        libs.main.getDir(SHPS_DIR_POOL) + $fileObject.fileName,
        libs.main.getDir(SHPS_DIR_UPLOAD) + $fileObject.requestState.config.generalConfig.URL.value + path.sep + $fileObject.fileName,
        libs.main.getDir(SHPS_DIR_UPLOAD) + $fileObject.fileName,
    ];

    var promList = [];
    let i = 0;
    var l = pathList.length;
    while (i < l) {

        promList.push(new Promise(function ($res, $rej) {

            var dex = i;
            var fStat = fs.stat(pathList[dex], function ($err, $stats) {

                if ($err) {

                    $res({
                        msg: libs.main.isDebug() ? $err
                            : '',

                        status: 500,
                        failed: true
                    });
                }
                else {

                    $res({

                        path: pathList[dex],
                        stats: $stats,
                    });
                }
            });
        }));

        i++;
    }

    Promise.all(promList).then(function ($vals) {

        var i = 0;
        var l = $vals.length;
        while (i < l) {

            if (!$vals[i].failed) {

                $fileObject.path = $vals[i].path;
                $fileObject.stats = $vals[i].stats;
                $cb(null, $fileObject);

                return;
            }

            i++;
        }

        $cb({
            msg: 'File could not be found!',
            status: 404,
        });
    });
};

/**
 * Read file data and add it to the fileObject
 *
 * @param $fileObject Object
 * @result Promise(fileObject or errorObject)
 */
var _addFileData = function f_file_serve_addFileData($fileObject, $cb) {

    var rs = fs.createReadStream($fileObject.path, { bufferSize: 64 * 1024 });
    rs.pause();

    $fileObject.fStream = libs.optimize.compressStream($fileObject.requestState, rs, $fileObject.stats.size);
    $fileObject.fStream.pause();

    $fileObject.requestState.once('headSent', function () {

        rs.resume();
        $fileObject.fStream.resume();
    });

    $cb(null, $fileObject);
};

/**
 * Zip (if necessary) and stream file to client
 *
 * @param $fileObject Object
 * @result Promise()
 */
var _zipNServe = function f_file_serve_zipNServe($fileObject, $cb) {

    $fileObject.requestState.isResponseBinary = true;
    $fileObject.requestState.httpStatus = 200;
    $fileObject.requestState.responseType = $fileObject.mimeType;
    var cd = $fileObject.requestState.request.headers['Referer'] ? 'attachment'
        : 'inline';

    var canGZIP = libs.SFFM.canGZIP($fileObject.requestState, $fileObject.stats.size);
    $fileObject.requestState.responseHeaders['Content-Type'] = $fileObject.mimeType + ';charset=utf-8';
    $fileObject.requestState.responseHeaders['Content-Disposition'] = cd + ';filename="' + $fileObject.fileName + '"';
    $fileObject.requestState.responseHeaders['Last-Modified'] = (new Date($fileObject.lastModified).toUTCString());
    if (canGZIP && $fileObject.compressedSize > 0) {

        $fileObject.compressedSize;
    }
    else if (canGZIP) {
                                    
        //TODO: Buffer file and then send it.
        $fileObject.requestState.responseHeaders['Content-Length'] = 0;
    }
    else if ($fileObject.size > 0) {

        $fileObject.requestState.responseHeaders['Content-Length'] = $fileObject.size;
    }
    else {
                                    
        //TODO: don't get file size if it already exists in the DB
        $fileObject.requestState.responseHeaders['Content-Length'] = $fileObject.stats.size;
    }

    $fileObject.requestState.responseHeaders['Trailer'] = 'Content-MD5';

    if ($fileObject.cache !== 0) {

        $fileObject.requestState.responseHeaders['Cache-Control'] = 'no-cache'; //, max-age=' + $fileObject.ttc;
        $fileObject.requestState.responseHeaders['ETag'] = $fileObject.hash;
    }
    else {

        $fileObject.requestState.responseHeaders['Cache-Control'] = 'no-store';
    }

    $fileObject.requestState.resultPending = false;
    $cb();

    var compSize = 0;
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');
    $fileObject.fStream
        .on('data', function ($chunk) {

            $fileObject.requestState.response.write($chunk);
            compSize += $chunk.length;
            hash.update($chunk, 'binary');
        })
        .once('end', function () {

            hash.end();
            var md5 = hash.read();
            $fileObject.requestState.response.addTrailers({

                'Content-MD5': md5
            });

            $fileObject.requestState.response.end();
            libs.sql.newSQL('default', $fileObject.requestState).done(function ($sql) {

                var tblU = $sql.openTable('upload');
                var vals = {

                    hash: md5,
                    size: $fileObject.stats.size,
                    compressedSize: compSize,
                };

                if (canGZIP) {

                    vals.compressedSize = compSize;
                }

                $sql.query()
                    .set(tblU, vals)
                    .fulfilling()
                    .eq(tblU.col('name'), $fileObject.name)
                    .execute()
                    .done($sql.free, $sql.free);
            });
        })
    ;
};

var _cacheLookup = function f_file_serve_cacheLookup($fileObject, $cb) {

    if (typeof $fileObject.requestState.request.headers['if-modified-since'] === 'undefined') {

        if (typeof $fileObject.requestState.request.headers['If-None-Match'] === 'undefined') {

            $cb(null, $fileObject);
        }
        else {

            if ($fileObject.requestState.request.headers['If-None-Match'] !== $fileObject.hash) {

                $cb(null, $fileObject);
            }
            else {

                $cb('cached');
            }
        }
    }
    else {

        if (new Date($fileObject.requestState.request.headers['if-modified-since']) < new Date($fileObject.lastModified * 1000)) {

            $cb(null, $fileObject);
        }
        else {

            $cb('cached');
        }
    }
};

me.serveFile = function f_file_serve_serveFile($requestState, $name) {

    var d = defer();

    var _errorFun = function ($err) {

        $requestState.httpStatus = $err.status;
        $requestState.responseBody = $err.msg;
        d.resolve();
    };

    var _cacheHit = function() {
        
        $requestState.httpStatus = 304;
        $requestState.responseBody = '';
        d.resolve();
    };

    // In preparation of the programmable workflows + content-pipeline let me present to you: the hard-coded workflow + pipeline
    // Well.. at least it looks a little like a pipeline... data is piped to the next function...
    async.waterfall([

        $cb => {

            $cb(null, $requestState, $name);
        },
        _getFileInfo,
        _hasAccessKey,
        _cacheLookup,
        _getFileLocation,
        _addFileData,
        _zipNServe,
    ], $err => {

        if ($err) {

            if ($err === 'cached') {

                _cacheHit();
            }
            else {

                _errorFun($err);
            }
        }
        else {

            d.resolve();
        }
    });

    return d.promise;
};
