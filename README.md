AcServer
========

[AcServer.js](AcServer.js) is a http webserver written in node.js also a
standalone executable [AcServer.exe](AcServer.exe) built with
[Node2exe](../node2exe).

It's not necessarily the most secure or feature rich server written in node.js.
I designed it for developing websites without the need for installing a web
server. Sometimes javascript and paths just don't work the same without a
server of some kind.

It supports https too but the certificate it uses by default is not a trustable
one.

Usage
-----

Copy [AcServer.exe](AcServer.exe) to the root of the directory you want to host
and it will start a web server on http://localhost/ hosting the contents of the
folder it's in.

### Other options
To host a https server on 127.0.0.2 port 9001

    AcServer.exe https://127.0.0.2:9001

To host a web server using a config file

    AcServer.exe MyConfig.conf

Config file
-----------

You can create a config file with some of or any of these settings which are
the defaults from [AcServer.js](AcServer.js).

    {
        handlers: [
            'plugins:./AcServer_plugins',
            'scripts:./AcServer_scripts',
            'default:.'
        ],
        scriptTimeout: 5000, // script timeout in milliseconds
        indexFile: 'index.html', // name of the index document
        rootDirectory: process.cwd(), // default root directory is the cwd, or the folder containing the config file if passed (set later)
        listDirectories: true, // show directory listings
        port: 80, // port to listen on
        https_cert: "AcServer.cert", // location of cert if using https, if not present a 100 year temporary will be used
        https_key: "AcServer.key", // location of key if using https, if not present a 100 year temporary will be used
        hostname: "localhost", // hostname to listen on
        debug: false, // show more info in log and page whilst debug is on
        https: false, // https not supported at present, must be false.
        hidden: [ // these will not be served or listed
            "/node.exe",
            "/AcServer_scripts",
            "/AcServer_plugins",
            "/AcServer.conf",
            "/AcServer.key",
            "/AcServer.exe",
            "/AcServer.cert",
            "/AcServer.cmd",
            "/AcServer.sh",
            "/AcServer.js",
            "/web.config",
            {"pattern": ".*\\/\\.(?:hg|svn|git)(\\/|$)", "modifiers": ""},
            {"pattern": ".*\\.acserver$", "modifiers": "i"},
            "/.hgignore",
            "/SciTEDirectory.properties"
        ],
        useIfModifiedSince: true, // if false the if-modified-since headers will be ignored
        addHidden: [], // if you set this in AcServer.conf it will append to the hidden list but not replace it
        useAbsoluteRedirect: true, // set to support some obscure older browsers
        useIfModifiedSinceString: true // better if-modified-since support
    }


Plugins
-------

The script folder, by default **AcServer_plugins**, can contain javascripts that
will all be executed when all paths are called until one of the plugins returns
true. Each script is a node module that exports a single function. Only files
ending in .js are executed.

Example: http://localhost/script1 will execute **AcServer_plugins/app1.js**
then **AcServer_plugins/app2.js** and so on.

For an example see [AcServer_plugins/fileServer.js](AcServer_scripts/fileServer.js.disabled)
which is the same as the built in directory listing function but as a plugin.


Scripts
-------

The script folder, by default **AcServer_scripts**, can contain javascripts that
will be executed when paths matching the name are called. Scripts are identical
to plugins except for when they are called. Only files
ending in .js are executed.

Example: http://localhost/script1 will execute **AcServer_scripts/script1.js** if
it is present.


Example **AcServer_scripts/hello.js**
    // an example AcServer script
    // the script must call context.send to finish it's exectution
    // context has context.response and context.request and context.config
    // objects along with some other functions.

    module.exports = function(context) {
        return context.send(200, 'hello script says hello from ' + context.request.url);
    }

