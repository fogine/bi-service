const HttpStatus = require('http-status-codes');
const logger     = require('bi-logger');
const debug      = require('debug')('errorHandler');

const RequestError = require('../error/requestError.js');
const ServiceError = require('../error/serviceError.js');
const AppStatus    = require('../express/appStatus.js');

module.exports = errorHandler;

//just so that we can properly test the recursive function
errorHandler.errorHandler = errorHandler;

/*
 * @private
 * Express error handler middleware
 *
 * @this === App
 */
function errorHandler(err, req, res, next) {
    var app = this;

    if (err === undefined) {
        return next();

    } else if (err === null) {
        err = new ServiceError({
            message: 'Got error of type NULL in the Error Hanlder middleware'
        });
        return errorHandler.errorHandler.call(app, err, req, res, next);

    } else if (err instanceof RequestError) {
        if (err instanceof ServiceError) {
            //req.routeUID can be empty (eg. RouteNotFoundError)
            err.setOrigin(req.routeUID);
            err.setUID(req.UID);
            app.emit('error', err);
        }

        debug(err.stack);
        res.status(err.code);
        return app.emitAsyncSeries('error-response', err, res).catch(function(err) {
            app.emit('error', err);
        });
    // matches every error object which includes the Error.prototype
    // in it's prototype chain and at the same time the error object is not dirrect
    // instance of the Error
    } else if (Error.prototype.isPrototypeOf(Object.getPrototypeOf(err))) {
        if (app.listenerCount('unknown-error')) {
            return app.emit('unknown-error', err, function(error) {
                if (!(error instanceof RequestError)) {
                    error = ServiceError.buildFrom(error);
                }
                return errorHandler.errorHandler.call(app, error, req, res, next);
            });
        }
        return errorHandler.errorHandler.call(app, ServiceError.buildFrom(err), req, res, next);

    } else if (err instanceof Error) {
        return errorHandler.errorHandler.call(app, ServiceError.buildFrom(err), req, res, next);
    }
};
