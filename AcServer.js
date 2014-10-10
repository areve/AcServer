/**
 * acserver.js is a simple web server in nodejs (the script can be renamed)
 * It serves files from the current directory, with directory listing support
 * It also supports plugins and scripts, no documentation though yet.
 * It also works in Azure simply replace the contents of server.js with this, and
 * if using https or non default port also add promoteServerVars="HTTPS,SERVER_PORT"
 * to <iisnode /> in web.config, although without this the site will probably work fine.
 *
 * Copyright Andrew Challen 2013
 * Apache License Version 2.0, http://www.apache.org/licenses/
 *
 * example usage:
 * sudo /opt/nodejs/bin/node acserver.js http://localhost:80
 */
(function() {
    // libraries
    var path = require("path"),
        fs = require("fs"),
        url = require("url"),
        util = require("util"),
        buffer = require('buffer');

    if (!fs.existsSync) {
        // for nodejs v0.6
        fs.existsSync = function(path) {
            try {
                return !!fs.lstatSync(path);
            } catch(ex) {
                return false;
            }
        }
    }

    var scriptName = path.basename(__filename, '.js');

    var isNode2exe = path.extname(process.execPath).toLowerCase() === '.exe' && path.basename(process.execPath).toLowerCase() !== 'node.exe';

    // if using node2exe use exe name instead
    if (isNode2exe) {
        scriptName = path.basename(process.execPath, '.exe');
    }

    // default config
    var defaultConfig = {
        handlers: [
            'plugins:./' + scriptName + '_plugins',
            'scripts:./' + scriptName + '_scripts',
            'default:.'
        ],
        scriptTimeout: 5000, // script timeout in milliseconds
        indexFile: 'index.html', // name of the index document
        rootDirectory: process.cwd(), // default root directory is the cwd, or the folder containing the config file if passed (set later)
        listDirectories: true, // show directory listings
        port: 80, // port to listen on
        https_cert: scriptName + ".cert", // location of cert if using https, if not present a 100 year temporary will be used
        https_key: scriptName + ".key", // location of key if using https, if not present a 100 year temporary will be used
        hostname: "localhost", // hostname to listen on
        debug: false, // show more info in log and page whilst debug is on
        https: false, // https not supported at present, must be false.
        hidden: [ // these will not be served or listed
            "/node.exe",
            "/" + scriptName + "_scripts",
            "/" + scriptName + "_plugins",
            "/" + scriptName + ".conf",
            "/" + scriptName + ".key",
            "/" + scriptName + ".exe",
            "/" + scriptName + ".cert",
            "/" + scriptName + ".cmd",
            "/" + scriptName + ".sh",
            "/" + scriptName + ".js",
            "/web.config",
            {"pattern": ".*\\/\\.(?:hg|svn|git)(\\/|$)", "modifiers": ""},
            {"pattern": ".*\\.acserver$", "modifiers": "i"},
            "/.hgignore",
            "/SciTEDirectory.properties"
        ],
        useIfModifiedSince: true, // if false the if-modified-since headers will be ignored
        addHidden: [], // if you set this in <scriptName>.conf it will append to the hidden list but not replace it
        useAbsoluteRedirect: true, // set to support some obscure older browsers
        useIfModifiedSinceString: true, // better if-modified-since support
        _hiddenCompiled: null, // used internally, not settable
        _azureListen: process.env.PORT, // used internally to detect if hosted on azure, not settable
        _azureHostname: process.env.WEBSITE_HOSTNAME, // used internally to detect if hosted on azure, not settable
        _configPath: null, // used internally not settable, once config is loaded this will be set
        _configModified: new Date(0) // this will contain a copy of configModified
    };

    // for testing this option uncomment the following line
    //~ process.argv[2] = 'https://localhost';
    //~ process.argv[2] = 'something.acserver';

    // live config will be stored in here
    var config;

    // null if there's no config otherwise the modified date of it so i can detect if it changes
    // must default to non null value for first load to compile though
    var configModified = new Date(0);
    var scriptModified = {};

    // read argv[2] which may be a config file with .acserver extension or http(s)://ip-address:port
    if (process.argv[2]) {
        if (fs.existsSync(process.argv[2])) {
            defaultConfig.rootDirectory = path.dirname(process.argv[2]);
            defaultConfig._configPath = process.argv[2];

            loadConfig();
        } else {
            var listen = process.argv[2];
            var regHttps = /^https:/i;
            defaultConfig.https = regHttps.test(listen);
            listen = listen.replace(/^\w*:\/\//, '');
            var parts = listen.split(':');
            if (parts[0] !== '') {
                defaultConfig.hostname = parts[0];
            }

            if (parts.length >= 2) {
                defaultConfig.port = parts[1] - 0;
            } else {
                defaultConfig.port = defaultConfig.https ? 443 : 80;
            }

            loadConfig();
        }
    } else {
        loadConfig();
    }

    /**
     * resets the config back to default
     */
    function resetConfig() {
        config = JSON.parse(JSON.stringify(defaultConfig));
    }

    if (config._azureListen) {
        console.log("Starting server on " + config._azureListen);
    } else {
        console.log("Starting server on " + (config.https ? 'https://' : 'http://') + config.hostname + ":" + config.port);
    }

    // ensure a nice message is shown when the server won't start
    var willNotStart = function(err) {
        if (err.code === 'EADDRINUSE') {
            console.log("Error: Address already in use.");
        } else {
            console.log(err);
        }
    }

    process.on("uncaughtException", willNotStart);

    // start the server
    var requestListener = function(request, response) {
        process.removeListener("uncaughtException", willNotStart);

        loadConfig();

        // create a context object for this request and response
        var context = {
            htmlEncode: htmlEncode,
            getContentType: getContentType,
            getHttpStatus: getHttpStatus,
            getRedirectUrl: function() {
                var full_url =
                    (context.request.headers['x-iisnode-https'] ?
                        (context.request.headers['x-iisnode-https'] === 'on' ? 'https' : 'http') :
                        (context.config.https ? 'https' : 'http')
                    ) +
                    '://' +
                    context.request.headers.host +
                    (context.request.headers['x-iisnode-server_port'] ?
                        (context.request.headers['x-iisnode-server_port'] === '80' || context.request.headers['x-iisnode-server_port'] === '443' ? '' : ':' + context.request.headers['x-iisnode-server_port']) :
                        (context.config.port === 80 || context.config.port == 443 ? '' : ':' + context.config.port)
                    ) +
                    context.request.url;

                var parsed_url = url.parse(full_url);
                var formatted_url = url.format(parsed_url);
                if (context.config.useAbsoluteRedirect || (context.config._azureListen && !context.request.headers['x-iisnode-https'])) {
                    // because at the moment I can't tell if my site is running on http or https
                    // i strip the protocol and domain, which is valid for most browsers and correct for the current RFC http://tools.ietf.org/html/rfc7231#section-7.1.2
                    formatted_url = formatted_url.replace(/^https?:\/\/[^\/]*/, '');
                }

                return formatted_url;
            },
            config: config, // TODO clone the config would be better to ensure it's readonly, watch out though for RegExp's
            statusCode: null,
            headers: {
                "Content-Type": "text/html; charset=utf-8"
            },
            response: response,
            request: request,
            closed: false,
            close: function(err) {
                context.closed = true;
                // don't reference this in this method, it's not bound
                if (err) context.err = err;

                clearTimeout(context.timeout);
                context.response.end();

                // log and then remove the uncaughtException handler
                // to get global.gc run node with --expose-gc
                var mem = '';
                if (global.gc) {
                    global.gc();
                    mem = '\t' + util.inspect(process.memoryUsage());
                }

                console.log(
                    (new Date()).toISOString() + "\t" +
                    context.statusCode + "\t" +
                    context.request.method + "\t" +
                    context.request.url +
                    (context.err ? "\t" + (context.config.debug ? (context.err.stack ? context.err.stack : context.err) : context.err) : '') +
                    mem);

                process.removeListener("uncaughtException", context.uncaughtException);

                if (context.config.debug) {
                    var keys = Object.keys(require.cache);
                    for (var i in keys) {
                        delete require.cache[keys[i]];
                    }
                }

            },
            uncaughtException: function(err) {
                context.send(err);
            },
            /**
             *
             * @param {object} err Overloaded depending on status code
             * @param {object} value Overloaded depending on status code
             */
            send: function(err, value) {
                if (err) {
                    if (typeof err === 'number') {
                        context.err = null;
                        context.statusCode = err;
                    } else {
                        context.err = err;
                        context.statusCode = 500;
                    }
                } else {
                    context.statusCode = 200;
                }

                switch(context.statusCode) {
                    case 302:
                        context.writeHead(302, {
                            "Location": value
                        });

                        context.response.write(context.getHttpStatus(context.statusCode));
                        context.close();
                        break;
                    case 404:
                    case 500:
                        if (!value) value = context.getHttpStatus(context.statusCode);
                    default:
                        if (typeof value !== 'string') {
                            if (typeof value === 'undefined' || value === null) {
                                value = ''
                            } else if (typeof value === 'object') {
                                context.headers["Content-Type"] = "application/json";
                                value = JSON.stringify(value);
                            } else {
                                value = '' + value;
                            }
                        }
                        if (!this.err) {
                            context.headers["Content-Length"] = Buffer.byteLength(value, 'utf8');
                        }

                        if (context.response.chunkedEncoding) {
                            context.headers["Transfer-Encoding"] = 'chunked';
                        }

                        context.writeHead(context.statusCode, context.headers);

                        context.response.write(value);

                        // if debuging show dump of response and request objects
                        if (this.err && context.config.debug) {
                            context.response.write(
                                "<hr /><pre>" +
                                (this.err.stack ? this.err.stack : this.err) +
                                '</pre>' +
                                '<hr /><pre>'+
                                htmlEncode(util.inspect(context, {depth: null})) +
                                "</pre>");
                        }

                        context.close(this.err);
                }

            },
            writeHead: function (statusCode, reasonPhrase, headers) {
                if (statusCode) context.statusCode = statusCode;
                context.response.writeHead.apply(context.response, arguments);
            },
            /**
             * Send file to the client
             * filePath {string} path to the file
             */
            sendFile: function(filePath) {
                var stat = fs.statSync(filePath);
                var lastModified = stat.mtime.toUTCString();
                var ifModifiedSince = context.request.headers["if-modified-since"];
                if (context.config.useIfModifiedSince && ifModifiedSince && lastModified === ifModifiedSince) {
                    context.writeHead(304);
                    context.close();
                } else {
                    context.writeHead(200, {
                        "Last-Modified": lastModified,
                        "Content-Type": getContentType(filePath),
                        "Content-Length": stat.size
                    });

                    var stream = fs.createReadStream(filePath);

                    // We replaced all the event handlers with a simple call to readStream.pipe()
                    stream.pipe(response);

                    stream.on('error', function(err){
                        context.close(err);
                    });
                    stream.on('close', function(){
                        context.close();
                    });
                }
            },
            executeScript: function(scriptPath) {
                scriptPath = require.resolve(scriptPath);
                var lastModified = fs.statSync(scriptPath).mtime.getTime();
                if (scriptModified[scriptPath] !== lastModified) {
                    scriptModified[scriptPath] = lastModified;
                    delete require.cache[scriptPath];
                }

                var script = require(scriptPath);
                return script.call(script, context);
            },
            process: function() {
                try {
                    for (var i in context.config.handlers) {
                        var handler = context.config.handlers[i];
                        var colon = handler.indexOf(':');
                        if (colon !== -1) {
                            handler = [handler.slice(0, colon), handler.slice(colon + 1)];
                        } else {
                            handler = [handler];
                        }

                        switch (handler[0].toLowerCase()) {
                            case 'plugins':
                                var pluginsPath = path.resolve(context.config.rootDirectory, handler[1]);

                                if (context.config.debug) console.log('Finding plugins in ' + pluginsPath);

                                if (fs.existsSync(pluginsPath)) {
                                    var stat = fs.statSync(pluginsPath);
                                    if (stat.isFile()) {
                                        if (path.extname(pluginsPath).toLowerCase() === '.js') {
                                            return context.executeScript(pluginsPath);
                                        }
                                    } else {
                                        var files = fs.readdirSync(pluginsPath);
                                        files.sort(function(a, b) {
                                            return a < b ? -1 : 1;
                                        });

                                        for (var j in files) {
                                            var pluginPath = path.join(pluginsPath, files[j]);
                                            if (path.extname(pluginPath).toLowerCase() === '.js') {
                                                if (context.executeScript(pluginPath)) return true;
                                            }
                                        }
                                    }
                                }

                                break;
                            case 'scripts':
                                // interpret request path into scripts path
                                var fileName = decodeURIComponent(url.parse(context.request.url).pathname);
                                if (fileName.slice(-1) === '/') {
                                    fileName = fileName.slice(0, -1);
                                }

                                var scriptPath = path.resolve(context.config.rootDirectory, path.join(handler[1], fileName + '.js'))

                                if (fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile()) {
                                    if (context.config.debug) console.log('Found script ' + scriptPath);
                                    return context.executeScript(scriptPath);
                                } else {
                                    if (context.config.debug) console.log('No script ' + scriptPath);
                                }

                                break;
                            case 'default':
                                return fileServer(context, handler[1]);
                            default:
                                return context.send('Unrecognised handler: ' + context.config.handlers[i]);
                                break;

                        }
                    }
                } catch (err) {
                    return context.send(err);
                }

                context.send(404);
            },
            timeout: setTimeout(function() {
                context.send('Script timeout');
            }, config.scriptTimeout)
        };

        // add error handler to this context, that will catch
        // uncaught exceptions and remove the hook when finished
        // TODO documentation says do not use uncaughtException
        process.on("uncaughtException", context.uncaughtException);

        context.process();
    };

    var app;
    if (config.https) {
        var https = require("https");
        // create a 100 year self signed certificate with openssl:
        // fetch openssl from http://openssl-for-windows.googlecode.com/files/openssl-0.9.8k_WIN32.zip
        // unpack openssl.cnf openssl.exe libeay32.dll and ssleay32.dll then run
        // openssl req -newkey rsa:2048 -new -nodes -x509 -days 36500 -keyout acserver.key -out acserver.cert -config openssl.cnf

        if (fs.existsSync(config.https_key) && fs.existsSync(config.https_cert)) {
            var options = {
              key: fs.readFileSync(config.https_key),
              cert: fs.readFileSync(config.https_cert)
            };
        } else {
            var options = {
              key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAkl4NHR25eDPe8E0Y/LzlnNk5fcaELxdZtOv7ysjiOWj15h3L\n7gJI41k2G32cKEmdXrKVphnPez8QZVwyMv0Vlg24Ib5f5jttjSRZnOAtryyMUR9b\nGhFJye9+EXA2nI4BeUoCsRvV7nVoBVeKuE7RBoOF9QeefGqUrzmiCWY9XfD8Imru\nq0c4CagLfhWE0k5OQ2gk1t9pqAAXyyMxuVLdj8ugV4QZRWiDaXtSmPgvMORv8ZB9\nfHAvKAVZ4jIYGS33XfHXeYDAPLm+LobLYp2P1IPV7GVWSkvINJti/9GmafGMPlML\nzakIvNmd85o/PMnQEl1FH8TAh7D44RG+rLXtVwIDAQABAoIBADVT+ycum1LGY2Xe\nUUpUcLxTEPVYjPSzZ0XZ7SWXR4VvTpiHJrQTNQdQi7w8adbr62CDZK7eHJBlC85C\nZy/YsjK30OzKdhpmcKXKJrRXoY1/h6hO6lx3DBF9JsunvN4Rh0vvwUdSQwHc2QeJ\nO8unO9VJulbqbb4a/w1QzE7sZ1OAWu7N2A2frsdeSyhDKL9eWMyNv/exyOZ3lcLe\nTogIhuNaTd84Py+ufCwnqsm31vHU3BvqjazDkL8ICbb6qLAbgFOwdlR3lEobhK+c\n4rvtdGjnZ4vnx70IgJpvrlu99KHIC6cR8Irus8DBlzly0RF6DHKWp9J9rwXveGuw\nSCLch5ECgYEAwfK3ME73hwd8zJI/Yppi3kR2els0A8Xl0h5XimsMM0Umn3aIo4+9\nX7Hy/X/vF+58JOTiLQ0yeAcHTaBcD+n4fOkKPujN3BI/x1/xG4mReXycjZmVOMNr\nOj85w5pPQG+Y2Ssg2wociQfMUdZk/+wLzFTV+wy+I9zwNoqp4sugxO0CgYEAwTI+\n1LARYC5ZnrK7bVjB8dzHzg/WtIJxdEkm+50Fulppzzk3WAjC1blr01BfFsUOwCjD\nZXoOYDz3WZE7ppeWkIeNEPQ2sG3Oshf3CAgL+fiomgwwaqrrTRBfyqFk+bfpLxte\ntXuIOXfMWUS/SZrFSMycrzScHPXnLhKj8TO8VtMCgYEAn0dzxoqzogM2LNNWluXv\nmFZlbqsEFq0pxtwATL8JL/n0dDVmldzwS2za//FXLDJBZhNK5HDYJ9at2sR9ltwx\npHPGZE/Q8JFUK6rRWioqfLkn4OpmsE1c/GL8T3Wk7Gg6AO/4dariMG9lDzihjcQP\nFGn/qcOXS+CgrkpGpulQSSkCgYANYWh+nI8nhS5J0oEuqpYMJUllWS16pQosjqB3\njsGFzZtEcecGXtz3pnb0VL2xOwaxgmE+Fv0F51MOTgO+nwMbkXfQs8lR4NkO9p/y\nW3RQ5MrwmGWGDb5sQPUReKogrX8l9xRRJ3Qg3s41ZJCHDYQabalwbQle7B0N0Nav\n7vBdZwKBgFfnTg6RH7/CloyDK+T7kWTitIF/JyW4GiwTtlLCCxZEeOl7d2GSBVEv\ng0kouRFnnC4m8d/3xLyYO8+jTATXQDT30ZtwvZcUvaaVPnzamlU0Suv7wvyIW7x6\nxKvUaR4bCdfnOJJPylkgDiHdb4POMnxh95u8EnFEZOH7kBmBPERP\n-----END RSA PRIVATE KEY-----\n',
              cert: '-----BEGIN CERTIFICATE-----\nMIIDfzCCAmegAwIBAgIJALJ8SZ05TMJIMA0GCSqGSIb3DQEBBQUAMDMxCzAJBgNV\nBAYTAlhYMREwDwYDVQQIEwhBY1NlcnZlcjERMA8GA1UEChMIQWNTZXJ2ZXIwHhcN\nMTQwMzE4MjIwNjUwWhcNNzgwMTE2MTUzODM0WjAzMQswCQYDVQQGEwJYWDERMA8G\nA1UECBMIQWNTZXJ2ZXIxETAPBgNVBAoTCEFjU2VydmVyMIIBIjANBgkqhkiG9w0B\nAQEFAAOCAQ8AMIIBCgKCAQEAkl4NHR25eDPe8E0Y/LzlnNk5fcaELxdZtOv7ysji\nOWj15h3L7gJI41k2G32cKEmdXrKVphnPez8QZVwyMv0Vlg24Ib5f5jttjSRZnOAt\nryyMUR9bGhFJye9+EXA2nI4BeUoCsRvV7nVoBVeKuE7RBoOF9QeefGqUrzmiCWY9\nXfD8Imruq0c4CagLfhWE0k5OQ2gk1t9pqAAXyyMxuVLdj8ugV4QZRWiDaXtSmPgv\nMORv8ZB9fHAvKAVZ4jIYGS33XfHXeYDAPLm+LobLYp2P1IPV7GVWSkvINJti/9Gm\nafGMPlMLzakIvNmd85o/PMnQEl1FH8TAh7D44RG+rLXtVwIDAQABo4GVMIGSMB0G\nA1UdDgQWBBRf0aPc2iJhBzPtLfZJ28Oj1xlm5jBjBgNVHSMEXDBagBRf0aPc2iJh\nBzPtLfZJ28Oj1xlm5qE3pDUwMzELMAkGA1UEBhMCWFgxETAPBgNVBAgTCEFjU2Vy\ndmVyMREwDwYDVQQKEwhBY1NlcnZlcoIJALJ8SZ05TMJIMAwGA1UdEwQFMAMBAf8w\nDQYJKoZIhvcNAQEFBQADggEBADlRHGYsgtnUEITy0heKU5GI7v3rXUGLUI0Ukoka\nSGJLw7hb1qJlfnREsYrl074a6936yy6b7k+KEPEXULbARqjpJd38kmA/lmgvwJhE\nHbU1x0moycjFngG4inFkBIhOQsufBZzOV7avtL7o7y2ylI9bK0Fsn+Bsh3AQOw6U\nHvxkTk7qPLRPp98EJmy+Iw636PlT1ZLEE9AERXc8bRZ3lBy0wg/O04/Fn6OfWDfU\ndvEp/ncruhGWcT5RqXPtCogNjh6YW29ktG09v6t+HtzTe/Ojdgw7PXFyi8xFQvt0\nyZrxn3NRPd2hIxb/1o1oN0AzNsCeft8KrI8iGBaD6UzZzVw=\n-----END CERTIFICATE-----\n'
            };
        }

        app = https.createServer(options, requestListener);
    } else {
        var http = require("http");
        app = http.createServer(requestListener);
    }

    app.setMaxListeners(0);
    if (config._azureListen) {
        app.listen(config._azureListen);
    } else {
        app.listen(config.port, config.hostname === '*' ? null : config.hostname);
    }

    /**
     * Html encodes minimal values
     * @param {string} value Value to encode.
     */
    function htmlEncode(value) {
        return ('' + value).replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * do any once only post processing on config
     */
    function compileConfig(){
        if (config.debug) console.log('Compiling config');
        config._hiddenCompiled = [];
        var hiddenLists = [config.hidden, config.addHidden]
        for (var j in hiddenLists) {
            for (var i in hiddenLists[j]) {
                var hidden = hiddenLists[j][i];
                if (typeof hidden === 'string') {
                    config._hiddenCompiled.push(hidden);
                } else {
                    config._hiddenCompiled.push(new RegExp(hidden.pattern, hidden.modifiers));
                }
            }
        }
    };

    /**
     * load .conf file if there is one, and reload if configModified does not
     * match it's modified date
     */
    function loadConfig(){
        var configPath = (config && config._configPath) || defaultConfig._configPath || scriptName + '.conf';

        if (fs.existsSync(configPath)) {
            var mtime = fs.statSync(configPath).mtime;
            if ((configModified ? configModified.getTime() : null) !== mtime.getTime()) {
                //if (config && config.debug)
                resetConfig();
                configModified = mtime
                config._configModified = mtime;
                var data = String(fs.readFileSync(configPath));

                // zero byte config files are allowed
                if (data.length !== 0) {
                    var json;
                    // eval allows comments in the config file
                    ////var json = JSON.parse(data);
                    eval('json = \n' + data);

                    for (var i in json) {
                        config[i] = json[i];
                    }

                    config._configPath = path.resolve(configPath);
                }
                compileConfig();
            }
        } else {
            if (configModified) {
                resetConfig();
                compileConfig();
                configModified = null;
                config._configModified = null;
            }
        }
    };

    function getHttpStatus(status) {
        return statusCodes[status];
    }

    function getContentType(filePath) {
        var i = filePath.lastIndexOf('.');
        var ext = (i < 0) ? filePath : filePath.substr(i + 1);
        return extTypes[ext.toLowerCase()] || 'application/octet-stream';
    }

    function fileServer(context, servePath) {
        servePath = servePath || '.';
        var pathname = url.parse(context.request.url).pathname;
        if (isHidden(pathname)) {
            return context.send(404);
        }

        var fullPath = path.join(
            path.resolve(context.config.rootDirectory, servePath),
            decodeURIComponent(url.parse(context.request.url).pathname));
        if (fs.existsSync(fullPath)) {
            fs.stat(fullPath, function(err, stat) {
                if (err) {
                    return context.send(404);
                }

                if (stat.isFile()) {
                    return context.sendFile(fullPath);
                } else {
                    // if not listing directories send 404
                    if (!context.config.listDirectories) {
                        return context.send(404);
                    }

                    if (context.request.url.slice(-1) !== '/') {
                        return context.send(302, context.getRedirectUrl() + '/');
                    }

                    if (context.config.indexFile) {
                        var indexFullPath = fullPath + context.config.indexFile;
                        if (fs.existsSync(indexFullPath) && fs.statSync(indexFullPath).isFile()) {
                            return context.sendFile(indexFullPath);
                        }
                    }

                    getDirList(fullPath, function(err, data) {
                        if (err) return context.send(500, null, err);

                        var lastModifiedString = new Date(data.lastModified).toUTCString();
                        var ifModifiedSinceString = context.request.headers["if-modified-since"];
                        if (context.config.useIfModifiedSinceString && ifModifiedSinceString && lastModifiedString === ifModifiedSinceString) {
                            context.writeHead(304);
                            return context.close();
                        }

                        context.headers["Last-Modified"] = lastModifiedString;
                        return context.send(null, dirListToHtml(data));
                    });
                }
            });
        } else {
            context.send(404);
        }

        return true;


        /**
         * Gets directory listing as an object
         */
        function getDirList(dirPath, cb) {
            fs.readdir(dirPath, function(err, files) {
                if (err) return cb(err);

                var data = {
                    path: url.parse(context.request.url).pathname,
                    list: [],
                    // if config file modified date is also included, because of filters
                    lastModified: context.config._configModified
                };

                if (data.path !== '/') {
                    data.parent = '..';
                }

                // show directory listing
                for (var i = 0, l = files.length; i < l; i++) {
                    var file = files[i];
                    if (!isHidden(url.resolve(data.path, file))) {
                        var stat = null;
                        try {
                            stat = fs.statSync(fullPath + file);
                        } catch(ex){
                            // statSync will fail if the folder is corrupt, or is a missing symbolic link etc.
                        }

                        if (stat) {
                            data.lastModified = Math.max(stat.mtime, data.lastModified);
                            if (stat.isDirectory()) {
                                data.list.push({ name: file, path: file, type: 'directory' });
                            } else {
                                data.list.push({ name: file, path: file, type: 'file' });
                            }
                        } else {
                            data.list.push({ name: file, path: file, type: 'unknown' });
                        }
                    }
                }

                return cb(null, data);
            });
        }

        /**
         * Converts directory list data to html
         */
        function dirListToHtml(data) {
            var html = [];
            html.push('<!DOCTYPE html>\n');
            html.push('<html>\n');
            html.push('\t<head>\n');
            html.push('\t\t<title>' + context.htmlEncode(data.path) + '</title>\n');
            html.push('\t\t<meta charset="UTF-8" />\n');
            html.push('\t</head>\n');
            html.push('\t<body>\n');
            html.push('\t\t<div class="directory-listing">\n');

            // show link to parent directory except for root
            if (data.path !== '/') {
                html.push('\t\t\t<div class="parent directory"><a href="..">..</a></div>\n');
            }

            for (var i in data.list) {
                var item = data.list[i];
                if (item.type === 'directory') {
                    // directory urls need a trailing slash
                    html.push('\t\t\t<div class="directory"><a href="' +
                        context.htmlEncode(encodeURIComponent(item.path)) + '/">' +
                        context.htmlEncode(item.path) +
                        '/</a></div>\n');
                } else if (item.type === 'file') {
                    html.push('\t\t\t<div class="file"><a href="' +
                        context.htmlEncode(encodeURIComponent(item.path)) + '">' +
                        context.htmlEncode(item.path) +
                        '</a></div>\n');
                } else {
                    html.push('\t\t\t<div class="unknown">' +
                        context.htmlEncode(item.path) +
                        '</div>\n');
                }
            }

            html.push('\t\t</div>\n');
            html.push('\t</body>\n');
            html.push('</html>');

            return html.join('');
        }
        /**
         * Determine whether this server relative path should be hidden from the
         * client.
         */
        function isHidden(path) {
            for (var i = 0; i < context.config._hiddenCompiled.length; i++) {
                if (context.config._hiddenCompiled[i] instanceof RegExp) {
                    if(context.config._hiddenCompiled[i].test(path)) {
                        return true;
                    }
                } else {
                    if(context.config._hiddenCompiled[i] === path) {
                        return true;
                    }
                }
            }

            return false;
        }
    }

    var statusCodes = {
        302: '302 Found',
        304: '304 Not Modified',
        404: '404 Not Found',
        500: '500 Internal Server Error'
    };

    var extTypes = {
        "3gp": "video/3gpp",
        "a": "application/octet-stream",
        "ai": "application/postscript",
        "aif": "audio/x-aiff",
        "aiff": "audio/x-aiff",
        "asc": "application/pgp-signature",
        "asf": "video/x-ms-asf",
        "asm": "text/x-asm",
        "asx": "video/x-ms-asf",
        "atom": "application/atom+xml",
        "au": "audio/basic",
        "avi": "video/x-msvideo",
        "bat": "application/x-msdownload",
        "bin": "application/octet-stream",
        "bmp": "image/bmp",
        "bz2": "application/x-bzip2",
        "c": "text/x-c",
        "cab": "application/vnd.ms-cab-compressed",
        "cc": "text/x-c",
        "chm": "application/vnd.ms-htmlhelp",
        "class": "application/octet-stream",
        "com": "application/x-msdownload",
        "conf": "text/plain",
        "cpp": "text/x-c",
        "crt": "application/x-x509-ca-cert",
        "css": "text/css",
        "csv": "text/csv",
        "cxx": "text/x-c",
        "deb": "application/x-debian-package",
        "der": "application/x-x509-ca-cert",
        "diff": "text/x-diff",
        "djv": "image/vnd.djvu",
        "djvu": "image/vnd.djvu",
        "dll": "application/x-msdownload",
        "dmg": "application/octet-stream",
        "doc": "application/msword",
        "dot": "application/msword",
        "dtd": "application/xml-dtd",
        "dvi": "application/x-dvi",
        "ear": "application/java-archive",
        "eml": "message/rfc822",
        "eps": "application/postscript",
        "exe": "application/x-msdownload",
        "f": "text/x-fortran",
        "f77": "text/x-fortran",
        "f90": "text/x-fortran",
        "flv": "video/x-flv",
        "for": "text/x-fortran",
        "gem": "application/octet-stream",
        "gemspec": "text/x-script.ruby",
        "gif": "image/gif",
        "gz": "application/x-gzip",
        "h": "text/x-c",
        "hh": "text/x-c",
        "htm": "text/html",
        "html": "text/html",
        "ico": "image/vnd.microsoft.icon",
        "ics": "text/calendar",
        "ifb": "text/calendar",
        "iso": "application/octet-stream",
        "jar": "application/java-archive",
        "java": "text/x-java-source",
        "jnlp": "application/x-java-jnlp-file",
        "jpeg": "image/jpeg",
        "jpg": "image/jpeg",
        "js": "application/javascript",
        "json": "application/json",
        "log": "text/plain",
        "m3u": "audio/x-mpegurl",
        "m4v": "video/mp4",
        "man": "text/troff",
        "mathml": "application/mathml+xml",
        "mbox": "application/mbox",
        "mdoc": "text/troff",
        "me": "text/troff",
        "mid": "audio/midi",
        "midi": "audio/midi",
        "mime": "message/rfc822",
        "mml": "application/mathml+xml",
        "mng": "video/x-mng",
        "mov": "video/quicktime",
        "mp3": "audio/mpeg",
        "mp4": "video/mp4",
        "mp4v": "video/mp4",
        "mpeg": "video/mpeg",
        "mpg": "video/mpeg",
        "ms": "text/troff",
        "msi": "application/x-msdownload",
        "odp": "application/vnd.oasis.opendocument.presentation",
        "ods": "application/vnd.oasis.opendocument.spreadsheet",
        "odt": "application/vnd.oasis.opendocument.text",
        "ogg": "application/ogg",
        "p": "text/x-pascal",
        "pas": "text/x-pascal",
        "pbm": "image/x-portable-bitmap",
        "pdf": "application/pdf",
        "pem": "application/x-x509-ca-cert",
        "pgm": "image/x-portable-graymap",
        "pgp": "application/pgp-encrypted",
        "pkg": "application/octet-stream",
        "pl": "text/x-script.perl",
        "pm": "text/x-script.perl-module",
        "png": "image/png",
        "pnm": "image/x-portable-anymap",
        "ppm": "image/x-portable-pixmap",
        "pps": "application/vnd.ms-powerpoint",
        "ppt": "application/vnd.ms-powerpoint",
        "ps": "application/postscript",
        "psd": "image/vnd.adobe.photoshop",
        "py": "text/x-script.python",
        "qt": "video/quicktime",
        "ra": "audio/x-pn-realaudio",
        "rake": "text/x-script.ruby",
        "ram": "audio/x-pn-realaudio",
        "rar": "application/x-rar-compressed",
        "rb": "text/x-script.ruby",
        "rdf": "application/rdf+xml",
        "roff": "text/troff",
        "rpm": "application/x-redhat-package-manager",
        "rss": "application/rss+xml",
        "rtf": "application/rtf",
        "ru": "text/x-script.ruby",
        "s": "text/x-asm",
        "sgm": "text/sgml",
        "sgml": "text/sgml",
        "sh": "application/x-sh",
        "sig": "application/pgp-signature",
        "snd": "audio/basic",
        "so": "application/octet-stream",
        "svg": "image/svg+xml",
        "svgz": "image/svg+xml",
        "swf": "application/x-shockwave-flash",
        "t": "text/troff",
        "tar": "application/x-tar",
        "tbz": "application/x-bzip-compressed-tar",
        "tcl": "application/x-tcl",
        "tex": "application/x-tex",
        "texi": "application/x-texinfo",
        "texinfo": "application/x-texinfo",
        "text": "text/plain",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "torrent": "application/x-bittorrent",
        "tr": "text/troff",
        "txt": "text/plain",
        "vcf": "text/x-vcard",
        "vcs": "text/x-vcalendar",
        "vrml": "model/vrml",
        "war": "application/java-archive",
        "wav": "audio/x-wav",
        "wma": "audio/x-ms-wma",
        "wmv": "video/x-ms-wmv",
        "wmx": "video/x-ms-wmx",
        "wrl": "model/vrml",
        "wsdl": "application/wsdl+xml",
        "xbm": "image/x-xbitmap",
        "xhtml": "application/xhtml+xml",
        "xls": "application/vnd.ms-excel",
        "xml": "application/xml",
        "xpm": "image/x-xpixmap",
        "xsl": "application/xml",
        "xslt": "application/xslt+xml",
        "yaml": "text/yaml",
        "yml": "text/yaml",
        "zip": "application/zip"
    }
}());
