'use strict';

const fs = require('fs');
const path = require('path');

const libs = require('node-mod-load').libs;
const q = require('q');


module.exports = function ($requestState, $fieldName) {

    const d = q.defer();

    var fileSize = 0;
    const file = $requestState.FILE[$fieldName];
    const maxFileSize = $requestState.config.generalConfig.uploadQuota;
    const dir = libs.main.getDir(SHPS_DIR_UPLOAD) + $requestState.config.generalConfig.URL;
    const filename = libs.SFFM.randomString(8) + '_' + file.filename;
    try {

        fs.accessSync(dir, fs.R_OK | fs.W_OK);
    }
    catch {

        fs.mkdirSync(dir, 0o644);
    }

    fs.open(dir + filename, 'w', 0o644, ($err, $fd) => {

        if ($err) {

            //TODO: ATTENTION: This is a hack! It is not documented
            file.fileStream.close();
            d.reject($err);
            return;
        }

        var refCount = 0;
        const onData = function ($data) {

            if (maxFileSize > 0) {

                fileSize += $data.length;
                if (fileSize > maxFileSize) {

                    //TODO: ATTENTION: This is a hack! It is not documented
                    file.fileStream.close();
                    return;
                }
            }

            refCount++;
            fs.write(fd, $data, null, file.encoding, $err => {

                refCount--;
                if ($err) {

                    file.fileStream.close();
                    file.uploaded = true;
                    d.reject($err);
                }
            });
        };

        const onEnd = function () {

            const wait = () => {

                if (refCount > 0 && d.inspect().state === 'pending') {

                    setTimeout(wait, 50);
                    return;
                }

                fs.close($fd, $err => {

                    if (d.inspect().state !== 'pending') {

                        return;
                    }

                    if ($err) {

                        d.reject($err);
                    }
                    else {

                        d.resolve(filename);
                    }
                });
            }
        };
    });

    if (maxFileSize == 0) {

        file.fileStream.on('data', onData);
        file.fileStream.on('end', onEnd);
    }
    else {

        //TODO: cache currently used space instead of calculating it from the DB
        libs.sql.newSQL('default', $requestState).done($sql => {

            const tbl = $sql.openTable('upload');
            $sql.query()
                .get(tbl.col('size'))
                .fulfilling()
                .eq(tbl.col('dataRoot'), '/upload')
                .execute()
                .done($rows => {

                    var i = 0;
                    const l = $rows.length;
                    while (i < l) {

                        maxFileSize -= $rows[i].size;
                        i++;
                    }

                    file.fileStream.on('data', onData);
                    file.fileStream.on('end', onEnd);
                }, d.reject);
        }, d.reject);
    }

    return d.promise;
};
