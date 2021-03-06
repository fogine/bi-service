'use strict';

module.exports = App;

const path              = require('path');
const url               = require('url');
const _                 = require('lodash');
const logger            = require('bi-logger');
const http              = require('http');
const https             = require('https');
const Promise           = require('bluebird');
const EventEmmiter      = require('events-bluebird');
const Express           = require('express');
const Validator         = require('ajv');
const validatorKeywords = require('ajv-keywords');

const utils                   = require('../utils.js');
const AppStatus               = require('./appStatus.js');
const Router                  = require('./router.js');
const routeNotFoundMiddleware = require('../middleware/routeNotFound');
const errorHandlerMiddleware  = require('../middleware/errorHandler');
const reqContentType          = require('../middleware/requestContentType.js');
const reqIdentityMiddleware   = require('../middleware/requestIdentity.js');
const appStatusCheckMiddleware= require('../middleware/appStatusCheck.js');

/**
 * App represents a bundle of {@link Router Routers} with {@link Route Routes}. It holds http[s] server object
 * or its equivalent/replacement and references to the {@link AppManager} and {@link Service}
 * instances which it was created from. It also manages its own `Config` instance with restricted scope
 *
 * @param {AppManager}   appManager
 * @param {Config}       config - module
 * @param {Object}       options
 * @param {String}       options.name - app's name
 * @param {Object}       [options.validator] - Ajv validator initialization options
 * @param {Object|Array} [options.validator.schemas] - list of globally accessible schema definitions
 *
 * @emits App#status-changed
 * @emits App#pre-init
 * @emits App#post-init
 * @emits App#pre-build
 * @emits App#post-build
 * @emits App#build-router
 * @emits App#listening
 * @emits App#error
 * @emits App#unknown-error
 * @emits App#error-response
 * @constructor
 **/
function App(appManager, config, options) {
    EventEmmiter.call(this);
    var app = this;

    /**
     * see affiliated `bi-config` npm package
     * @name App#config
     * @instance
     * @type {Config}
     */
    this.config          = config;
    /**
     * @name App#appManager
     * @instance
     * @type {AppManager}
     */
    this.appManager      = appManager;
    /**
     * @name App#service
     * @instance
     * @type {Service}
     */
    this.service         = appManager.service;
    /**
     * @name App#resourceManager
     * @instance
     * @type {ResourceManager}
     */
    this.resourceManager = this.service.resourceManager;
    this.expressApp      = Express();
    this.routers         = [];
    this.routes          = {}; //indexed by its UID
    this.server          = null;
    this.doc             = null; // related documentation server App ref
    /**
     * one of {@link AppStatus} enum
     * @name App#status
     * @instance
     * @type {String}
     */
    this.status          = null; // private
    this.statusReason    = null; // private
    this.options         = ( options && _.cloneDeep(options) ) || {};
    this.validator       = null;

    if (!this.options.name) {
        throw new Error('App `name` option is mandatory');
    }

    //we have to exlicitly add 'memory' store to the config to be able
    //to write to it as 'literal' or 'default' store is readonly!
    if (config.stores && !config.stores.memory) {
        config.use('memory');
    }

    //App specific Router
    /**
     * App specific Router constructor
     * @name App#Router
     * @instance
     * @type {Function}
     */
    this.Router = function() {
        Router.apply(this, arguments);
    };
    this.Router.prototype = Object.create(Router.prototype);
    this.Router.prototype.constructor = Router;
    this.Router.prototype.App = this;

    this.$setStatus(AppStatus.INIT);
    app.service.resourceManager.register(`config-${app.options.name}`, config);
    app.$normalizeConfig();
    app.$init();
};

App.prototype = Object.create(EventEmmiter.prototype);
App.prototype.constructor = App;
App.prototype.super = EventEmmiter.prototype;

/**
 * registeres event listener.  
 * overrides event emmiter implementation
 *
 * @extends EventEmitter
 *
 * @param {String} event
 * @param {Function} callback
 * @return {Boolean}
 */
App.prototype.on = function(event) {
    switch (event) {
        case 'unknown-error':
            if (this.listenerCount(event) >= 1) {
                throw new Error('You can assign only single listener for the event');
            }
            break;
    }

    return this.super.on.apply(this, arguments);
};

/**
 * @private
 * @return {undefined}
 */
App.prototype.$normalizeConfig = function() {

    // set basePath
    var rootPath = this.config.get('baseUrl') || '';
    var host, protocol;
    if (rootPath) {
        //an url without protocol are not valid according to specs
        if (!rootPath.match(/^http(s)?/)) {
            rootPath = 'http://' + rootPath;
        }
        rootPath = url.parse(rootPath);
        host = rootPath.host;
        protocol = rootPath.protocol;
        rootPath = rootPath.pathname || '';
    }

    this.config.set('basePath', rootPath);
    this.config.set('host', host || '');
    this.config.set('protocol', protocol || '');
};

/**
 * @param {String} status - see {AppStatus} enum for available option values
 * @param {mixed} reason
 *
 * @private
 * @return {undefined}
 */
App.prototype.$setStatus = function(status, reason) {
    var app = this;

    process.nextTick(function() {
        if (app.status === AppStatus.ERROR) {
            return;
        }

        app.status = status;
        app.statusReason = reason;
        app.emit('status-changed', status);
    });
};

/**
 * @private
 * @return {undefined}
 */
App.prototype.$init = function() {

    var self = this;
    this.expressApp.locals.getUrl = function getUrl(uid, pathParams, queryParams) {
        return self.getRoute(uid).getUrl(pathParams, queryParams);
    };

    //cache routes, validate route UIDs
    this.on('build-router', function(router) {
        var app = this;

        router.on('build-route', function(route) {
            if (app.routes.hasOwnProperty(route.uid)) {
                throw new Error(`Route uid: ${route.uid} must be unique.`);
            }
            app.routes[route.uid] = route;;
        });
    });

    process.nextTick(function(app) {
        var options = app.options;
        var headers = app.config.get('response:headers') || [];

        app.emit('pre-init', app);

        //generates unique uid for each request
        app.use(reqIdentityMiddleware.bind(app));


        app.expressApp.set('trust proxy', 'uniquelocal');
        //app.expressApp.set('view engine', 'ejs');
        app.expressApp.disable('x-powered-by');

        // Set default response headers & make sure req.body is an object
        app.use(function(req, res, next) {

            res.removeHeader('server', '*');
            headers.forEach(function(header) {
                res.setHeader.apply(res, header);
            });

            if (!req.body) {
                req.body = {};
            }

            return next();
        });

        if (app.config.get('stopOnError') === true) {
            app.use(appStatusCheckMiddleware.bind(app));
        }

        // Express global error handling
        app.once('post-build', function(app) {
            app.use('*', routeNotFoundMiddleware.bind(app));
            app.use(errorHandlerMiddleware.bind(app));
        });

        app.on('status-changed', function(status) {
            if (   status === AppStatus.ERROR
                && app.config.get('stopOnError') === true
            ) {
                logger.error(`The ${app.options.name} app has stopped processing all requests to prevent any further data damage`);
            }
        });

        //default error response fallback,
        //`error-response` listeners are handled asynchronously in a series
        app.on('error-response', function(err, res) {
            if (!res.headersSent) {
                res.json(err);
            }
        });

        app.emit('post-init', app);
    }, this);
};

/**
 * @return {Ajv} validator instance
 */
App.prototype.getValidator = function() {
    if (this.validator === null) {
        let defaults = {
            $data: true, //data json references
            allErrors: false,
            verbose: true, //include validated data in errors
            schemaId: '$id',
            //it should fail if other keywords are present
            //along the $ref keywords in the schema
            extendRefs: 'fail',
            //only additional properties with additionalProperties keyword
            //equal to false are removed
            additionalProperties: true,
            removeAdditional: true,
            useDefaults: true,
            coerceTypes: true,
            passContext: true, //pass validation context to custom keyword functions
        };

        this.validator = new Validator(_.assign(
            defaults, this.options.validator || {}
        ));

        //register keywords from ajv-keywords package
        validatorKeywords(this.validator);

        //custom ajv keywords provided by bi-service
        utils.registerCustomKeywords(this.validator);
    }

    return this.validator;
};

/**
 * returns protocol + host url string
 * @return {String}
 */
App.prototype.getHost = function() {
    return `${this.config.get('protocol')}//${this.config.get('host')}`;
};

/**
 * registers connect-session middleware
 * @param {CacheStoreInterface} store
 *
 * @return {CacheStoreInterface}
 */
App.prototype.useSession = function(store) {

    var sessionOpt  = _.cloneDeep(this.config.get('session'));
    sessionOpt.store = store;
    this.use(require('express-session')(sessionOpt));

    return store;
};

/**
 * bind application-level middleware to an instance of the app object by using the app.use()
 *
 * @param {String} [endpoint]
 * @param {Function} [callback]
 *
 * @return {undefined}
 */
App.prototype.use = function() {
    var args = Array.prototype.slice.call(arguments, 0);
    return this.expressApp.use.apply(this.expressApp, args);
};

/**
 * @param {String} uid
 *
 * @throws Error - when route is not found
 * @return {Route}
 */
App.prototype.getRoute = function(uid) {
    if (!this.routes.hasOwnProperty(uid)) {
        throw new Error(`Route ${uid} not found`);
    }

    return this.routes[uid];
};

/**
 * @private
 * @return {ExpressRouter}
 */
App.prototype.$buildExpressRouter = function() {
    return Express.Router();
};

/**
 * @param {Integer} defaultValue
 *
 * @private
 * @return {Integer}
 */
App.prototype.$getTimeoutInterval = function(defaultValue) {
    var timeout = this.config.get('request:timeout');
    if (typeof timeout === 'number') {
        return timeout;
    } else if (typeof defaultValue === 'number') {
        return defaultValue;
    }
    return 0;
};

/**
 * @param {Object} options
 * @param {String} [options.public]
 * @param {String} [options.version]
 * @param {String} options.url
 *
 * @return {Router}
 */
App.prototype.buildRouter = function(options) {
    var router = new this.Router(options);
    this.routers.push(router);

    this.emit('build-router', router);
    return router;
};

/**
 * @private
 * @return {App}
 */
App.prototype.build = function() {
    var app = this;

    process.nextTick(function() {
        app.emit('pre-build', app);

        app.routers.forEach(function(router) {
            app.expressApp.use(router.getUrl(), router.$buildExpressRouter());
        });

        app.emit('post-build', app);
    });

    return app;
};

/**
 * start http(s) server listening on configured port
 *
 * @param {Integer|String} port - or socket
 * @param {String}         [hostname]
 * @param {Integer}        [backlog] - the maximum length of the queue of pending connections. The actual length will be determined by your OS through sysctl settings such as tcp_max_syn_backlog and somaxconn on linux. The default value of this parameter is 511 (not 512).
 * @param {Object}         [options]
 * @param {Boolean}        [options.ssl=false]
 *
 * @return http[s].Server
 */
App.prototype.listen = function() {
    var args = Array.prototype.slice.call(arguments, 0, 3);
    var app = this;
    var options = {
        ssl: false,
        cli: false
    };

    if (app.status === AppStatus.ERROR) {
        throw app.statusReason;
    }

    if (app.server !== null) {
        //if we needed the app to listen on both https and http, we should handle this on system level
        throw new Error('Another Server is already running.');
    }

    if (_.isPlainObject(arguments[arguments.length -1])) {
        options = _.assign(options, arguments[arguments.length -1])
    }

    var protocol = options.ssl ? https : http;

    app.server = protocol.createServer(app.expressApp);
    app.server.setTimeout(this.$getTimeoutInterval(10000));//10s

    app.server.on('error', function(err) {
        app.emit('error', err);
    });
    app.server.once('listening', function() {
        app.$setStatus(AppStatus.OK);
        app.emit('listening', app);
    });

    return app.server.listen.apply(app.server, args);
};

/**
 * shutdown server. if not running, resolved Promise will be returned
 * @return {Promise}
 */
App.prototype.close = function() {
    var app = this;

    return new Promise(function(resolve, reject) {
        if (!app.server || app.server.address() === null) {
            return resolve();
        }

        app.server.close(function(err) {
            if (err) return reject(err);
            resolve(app.server);
        });
    });
};

// ==================== JSDOC APP EVENTS DEFINITIONS ======================== //

/**
 * emitted once each time after status change.
 * Once you get {@link AppStatus#ERROR} status, the App's status can NOT
 * be changed thus no more `status-changed` events will be emitted.
 *
 * @event App#status-changed
 * @property {String} status - see {@link AppStatus} enum for available option values
 */

/**
 * emitted before internal initialization of the App instance
 *
 * @event App#pre-init
 * @property {App} app
 */

/**
 * emitted after internal initialization of the App instance. At this point the
 * App instance should be fully initiallized.
 *
 * @event App#post-init
 * @property {App} app
 */

/**
 * emitted before app route definitions are assembled into a single function.
 *
 * @event App#pre-build
 * @property {App} app
 */

/**
 * emitted after app route definitions are assembled into a single function and
 * binded to internal http[s] server.
 *
 * @event App#post-build
 * @property {App} app
 */

/**
 * emitted with each {@link App#buildRouter} method call.
 *
 * @event App#build-router
 * @property {Router} router
 */

/**
 * reflects http[s] server `listening` event
 *
 * @event App#listening
 * @property {App} app
 */

/**
 * fires each time an unexpected internal Error is encoutered.
 * When the Error is catched in user space
 * (aka. doesn't come early from eg. internal http[s] server), the Error is converted
 * to {@link ServiceError}.  
 *
 * Internal listener is binded at initialization time which logs all received
 * Errors. {@link App#status} is also updated with the first internal error.
 * @event App#error
 * @property {Error} error
 */

/**
 * By default an {@link App} handles all "expected" & unexpected Errors automatically
 * and responds to a request accordingly.  
 * By pushing a listener to this event, you have a chance to define custom user
 * error processing logic and respond to the request manually.  
 * Listeners of this event are executed asynchronously - Promises are supported.
 *
 * @example
 *
 * app.on('error-response', function(err, res) {
 *     //pseudocode:
 *     //renders html view and sends html response instead of default json response
 *     return res.render('error', err); //returns a Promise
 * });
 *
 * @event App#error-response
 * @property {RequestError} err
 * @property {http.ServerResponse} res - response
 */

/**
 * Is emitted before a response to a request is sent and allows to convert
 * an unknown error (an error which is not instanceof {@link RequestError}
 * and at the same time is not **dirrect** instanceof [Error](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error))
 * to {@link RequestError} which will be then processed in place of the original unknown error object.  
 * if no listener is present all unknown errors will be automatically converted to {@link ServiceError}
 *
 * @example
 *
 * app.on('unknown-error', function(err, errorHandler) {
 *     if (err instanceof SequelizeUniqueConstraintError) {
 *         return errorHandler(new RequestError('Entity already exists'));
 *     }
 *     //hand back the error processing to the application
 *     return errorHandler(err);
 * });
 *
 * @event App#unknown-error
 * @property {Error} err
 * @property {Function} errorHandler - callback function
 */

// ========================================================================== //
