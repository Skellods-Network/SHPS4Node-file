'use strict';

var me = module.exports;

var crypto = require('crypto');
var q = require('q');
var fs = require('fs')
var oa = require('object-assign');
var stream = require('stream');
var util = require('util');

var libs = require('node-mod-load').libs;

var serveMod = require('./serve.js');

var _serveFile = me.serveFile = serveMod.serveFile;
var _handleUpload = me.handleUpload = require('./file.handleUpload.c.js');
